// mutator 参数里单个自由文本字段的上限（Issue #150）：超过 MAX_TEXT_ARG_LENGTH 在 zod 校验处拒绝，恰好等于上限放行。
import { describe, expect, test } from 'vitest';

import {
  createSchema,
  createTable,
  EditError,
  emptyModel,
  getDialect,
  MAX_TEXT_ARG_LENGTH,
  runMutator,
} from '../src/index.ts';

describe('mutator 自由文本字段上限', () => {
  const setup = () => {
    const m = emptyModel('mysql');
    const t = createTable(m, createSchema(m, getDialect('mysql').capabilities.defaultSchema), 'orders');
    return { m, t };
  };

  test('列类型：超过上限拒绝且不改模型，恰好等于上限放行（长 ENUM）', () => {
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
    ).toThrow(new EditError('参数不合法：文本太长：单个字段最多 100 万个字符'));
    expect(m).toEqual(before);

    // 真实的大 ENUM（5000 个取值）远低于上限
    const big = `enum(${Array.from({ length: 5000 }, (_, i) => `'value_${i}'`).join(',')})`;
    runMutator(m, 'addColumn', { table: t, column: { id: 'c2', name: 'kind', type: big } });
    expect(() => runMutator(m, 'setColumnType', { id: 'c2', type: over, typeRef: null })).toThrow(EditError);
  });

  test('注释与 CHECK 表达式同样受限', () => {
    const { m, t } = setup();
    expect(() =>
      runMutator(m, 'setComment', { id: t, comment: 'x'.repeat(MAX_TEXT_ARG_LENGTH + 1) }),
    ).toThrow(EditError);
    runMutator(m, 'setComment', { id: t, comment: 'x'.repeat(MAX_TEXT_ARG_LENGTH) });
    expect(() =>
      runMutator(m, 'addCheck', { id: 'k1', table: t, expr: '1 = 1 ' + ' '.repeat(MAX_TEXT_ARG_LENGTH) }),
    ).toThrow(EditError);
  });
});
