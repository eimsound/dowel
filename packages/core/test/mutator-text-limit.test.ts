// mutator 参数里单个自由文本字段的上限（Issue #150）：超过 MAX_TEXT_ARG_LENGTH 在 zod 校验处拒绝，恰好等于上限放行；
// 同时确认 IR Model schema 不受限，存量模型加载与回读不受影响。
import { describe, expect, test } from 'vitest';

import {
  createSchema,
  createTable,
  type Dialect,
  EditError,
  emptyModel,
  getDialect,
  MAX_TEXT_ARG_LENGTH,
  Model,
  runMutator,
} from '../src/index.ts';

describe('mutator 自由文本字段上限', () => {
  const setup = (dialect: Dialect = 'mysql') => {
    const m = emptyModel(dialect);
    const schema = createSchema(m, getDialect(dialect).capabilities.defaultSchema);
    const t = createTable(m, schema, 'orders');
    return { m, schema, t };
  };

  const tooLongMsg = new EditError('参数不合法：文本太长：单个字段最多 100 万个字符');
  const atLimit = (prefix: string) => prefix + ' '.repeat(MAX_TEXT_ARG_LENGTH - prefix.length);
  const overLimit = (prefix: string) => prefix + ' '.repeat(MAX_TEXT_ARG_LENGTH + 1 - prefix.length);

  test('列类型：超过上限拒绝且不改模型，恰好等于上限放行（长 ENUM）', () => {
    expect(MAX_TEXT_ARG_LENGTH).toBe(1_000_000);
    const { m, t } = setup();
    const before = structuredClone(m);
    const enumOf = (len: number) => {
      const head = 'enum(';
      const body = "'v',".repeat(Math.ceil(len / 4));
      return (head + body).slice(0, len - 1) + ')';
    };
    const over = enumOf(MAX_TEXT_ARG_LENGTH + 1);
    expect(over.length).toBe(MAX_TEXT_ARG_LENGTH + 1);
    expect(() =>
      runMutator(m, 'addColumn', { table: t, column: { id: 'c1', name: 'status', type: over } }),
    ).toThrow(tooLongMsg);
    expect(m).toEqual(before);

    // 真实的大 ENUM（5000 个取值）远低于上限
    const big = `enum(${Array.from({ length: 5000 }, (_, i) => `'value_${i}'`).join(',')})`;
    runMutator(m, 'addColumn', { table: t, column: { id: 'c2', name: 'kind', type: big } });
    const beforeSet = structuredClone(m);
    expect(() => runMutator(m, 'setColumnType', { id: 'c2', type: over, typeRef: null })).toThrow(tooLongMsg);
    expect(m).toEqual(beforeSet);

    const pg = setup('pg');
    expect(() =>
      runMutator(pg.m, 'addColumn', { table: pg.t, column: { id: 'c1', name: 'id', type: over } }),
    ).toThrow(tooLongMsg);
    runMutator(pg.m, 'addColumn', { table: pg.t, column: { id: 'c1', name: 'id', type: 'serial' } });
    expect(() => runMutator(pg.m, 'setColumnType', { id: 'c1', type: over, typeRef: null })).toThrow(
      tooLongMsg,
    );
  });

  test('注释与 CHECK 表达式同样受限', () => {
    const { m, t } = setup();
    expect(() =>
      runMutator(m, 'setComment', { id: t, comment: 'x'.repeat(MAX_TEXT_ARG_LENGTH + 1) }),
    ).toThrow(tooLongMsg);
    runMutator(m, 'setComment', { id: t, comment: 'x'.repeat(MAX_TEXT_ARG_LENGTH) });
    expect(() =>
      runMutator(m, 'addCheck', { id: 'k1', table: t, expr: '1 = 1 ' + ' '.repeat(MAX_TEXT_ARG_LENGTH) }),
    ).toThrow(tooLongMsg);
  });

  test('ColumnDefault.expr（addColumn / setDefault）受限于 MAX_TEXT_ARG_LENGTH', () => {
    const { m, t } = setup('pg');
    const before = structuredClone(m);
    expect(() =>
      runMutator(m, 'addColumn', {
        table: t,
        column: { id: 'c1', name: 'note', type: 'text', default: { expr: overLimit("'ok'") } },
      }),
    ).toThrow(tooLongMsg);
    expect(m).toEqual(before);

    runMutator(m, 'addColumn', {
      table: t,
      column: { id: 'c1', name: 'note', type: 'text', default: { expr: atLimit("'ok'") } },
    });
    expect(() => runMutator(m, 'setDefault', { id: 'c1', default: { expr: overLimit("'v2'") } })).toThrow(
      tooLongMsg,
    );
    runMutator(m, 'setDefault', { id: 'c1', default: { expr: atLimit("'v2'") } });
  });

  test('IndexElement 的 expr / opclass / collation 受限于 MAX_TEXT_ARG_LENGTH', () => {
    const { m, t } = setup('pg');
    runMutator(m, 'addColumn', { table: t, column: { id: 'c1', name: 'name', type: 'text' } });
    const before = structuredClone(m);

    expect(() =>
      runMutator(m, 'addIndex', {
        id: 'ix_over_expr',
        table: t,
        elements: [{ expr: overLimit('lower(name)') }],
      }),
    ).toThrow(tooLongMsg);
    expect(() =>
      runMutator(m, 'addIndex', {
        id: 'ix_over_opclass',
        table: t,
        elements: [{ column: 'c1', opclass: overLimit('text_pattern_ops') }],
      }),
    ).toThrow(tooLongMsg);
    expect(() =>
      runMutator(m, 'addIndex', {
        id: 'ix_over_coll',
        table: t,
        elements: [{ column: 'c1', collation: overLimit('"C"') }],
      }),
    ).toThrow(tooLongMsg);
    expect(m).toEqual(before);

    runMutator(m, 'addIndex', {
      id: 'ix_ok',
      table: t,
      elements: [
        {
          expr: atLimit('lower(name)'),
          opclass: atLimit('text_pattern_ops'),
          collation: atLimit('"C"'),
        },
      ],
    });
  });

  test('ColumnExt.mysql（enumValues / setValues）与 ColumnExt.mssql.identity 受限于 MAX_TEXT_ARG_LENGTH', () => {
    const { m, t } = setup('mysql');
    const before = structuredClone(m);
    expect(() =>
      runMutator(m, 'addColumn', {
        table: t,
        column: { id: 'c1', name: 'tags', type: 'set', ext: { mysql: { setValues: [overLimit('a')] } } },
      }),
    ).toThrow(tooLongMsg);
    expect(m).toEqual(before);

    runMutator(m, 'addColumn', {
      table: t,
      column: { id: 'c1', name: 'tags', type: 'enum', ext: { mysql: { enumValues: [atLimit('a')] } } },
    });
    expect(() =>
      runMutator(m, 'setColumnExt', {
        id: 'c1',
        ext: { mysql: { enumValues: [overLimit('b')] } },
      }),
    ).toThrow(tooLongMsg);
    runMutator(m, 'setColumnExt', {
      id: 'c1',
      ext: { mysql: { setValues: [atLimit('b')] } },
    });

    const ms = setup('mssql');
    expect(() =>
      runMutator(ms.m, 'addColumn', {
        table: ms.t,
        column: {
          id: 'c_id',
          name: 'id',
          type: 'int',
          ext: { mssql: { identity: { seed: overLimit('1'), increment: '1' } } },
        },
      }),
    ).toThrow(tooLongMsg);
    runMutator(ms.m, 'addColumn', {
      table: ms.t,
      column: {
        id: 'c_id',
        name: 'id',
        type: 'int',
        ext: { mssql: { identity: { seed: atLimit('1'), increment: atLimit('1') } } },
      },
    });
    expect(() =>
      runMutator(ms.m, 'setColumnExt', {
        id: 'c_id',
        ext: { mssql: { identity: { seed: '1', increment: overLimit('1') } } },
      }),
    ).toThrow(tooLongMsg);
  });

  test('SequenceOptions 与 PartitionKey 字符串字段受限于 MAX_TEXT_ARG_LENGTH', () => {
    const { m, schema, t } = setup('pg');
    for (const field of ['increment', 'min', 'max', 'start', 'cache'] as const) {
      expect(() =>
        runMutator(m, 'createSequence', {
          id: `seq_bad_${field}`,
          schema,
          name: `seq_bad_${field}`,
          options: { [field]: overLimit('1') },
        }),
      ).toThrow(tooLongMsg);
    }
    runMutator(m, 'createSequence', {
      id: 'seq_ok',
      schema,
      name: 'seq_ok',
      options: {
        increment: atLimit('1'),
        min: atLimit('1'),
        max: atLimit('999'),
        start: atLimit('1'),
        cache: atLimit('1'),
      },
    });

    expect(() =>
      runMutator(m, 'addColumn', {
        table: t,
        column: {
          id: 'c_seq',
          name: 'id',
          type: 'bigint',
          identity: { always: true, options: { start: overLimit('1') } },
        },
      }),
    ).toThrow(tooLongMsg);

    runMutator(m, 'addColumn', { table: t, column: { id: 'c_part', name: 'k', type: 'text' } });
    for (const key of [
      { expr: overLimit('k') },
      { column: 'c_part', opclass: overLimit('text_ops') },
      { column: 'c_part', collation: overLimit('"C"') },
    ]) {
      expect(() =>
        runMutator(m, 'setPartitionBy', {
          id: t,
          partitionBy: { strategy: 'range', keys: [key] },
        }),
      ).toThrow(tooLongMsg);
      expect(() =>
        runMutator(m, 'createTable', {
          id: 't_part_bad',
          schema,
          name: 't_part_bad',
          partitionBy: { strategy: 'range', keys: [key] },
        }),
      ).toThrow(tooLongMsg);
    }
    runMutator(m, 'setPartitionBy', {
      id: t,
      partitionBy: {
        strategy: 'range',
        keys: [{ expr: atLimit('k'), opclass: atLimit('text_ops'), collation: atLimit('"C"') }],
      },
    });
  });

  test('IR Model.parse 仍兼容已有存量模型中的超长文本字段', () => {
    const { m, t } = setup('pg');
    runMutator(m, 'addColumn', { table: t, column: { id: 'c1', name: 'body', type: 'text' } });
    const stored = structuredClone(m);
    const col = stored.objects.c1!;
    if (col.kind === 'column') {
      col.comment = 'x'.repeat(MAX_TEXT_ARG_LENGTH + 50);
      col.default = { expr: overLimit("'legacy'") };
    }
    const parsed = Model.parse(stored);
    expect(parsed.objects.c1?.comment?.length).toBe(MAX_TEXT_ARG_LENGTH + 50);
  });
});
