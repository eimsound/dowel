import { describe, expect, test } from 'vitest';

import * as E from '../src/index.ts';

describe('表达式改写', () => {
  test('枚举改名后，默认值里的限定名跟着改', () => {
    const m = E.emptyModel();
    const s = E.createSchema(m, 'public');
    const e = E.createEnum(m, s, '名字', ['x']);
    const t = E.createTable(m, s, 't');
    const c = E.addColumn(m, t, { name: 'c', type: '', typeRef: e, default: { expr: `'x'::public."名字"` } });
    E.renameEnum(m, e, 'user');
    expect(E.get(m, c, 'column').default).toEqual({ expr: `'x'::public."user"` });
  });

  test('列改名只改列引用，不改函数名、类型名、字符串', () => {
    expect(E.renameInExpr(`(lower(a) <> 'a'::text) AND (a > 0) AND (b.a IS NULL)`, 'a', 'Mixed Case')).toBe(
      `(lower("Mixed Case") <> 'a'::text) AND ("Mixed Case" > 0) AND (b."Mixed Case" IS NULL)`,
    );
    expect(E.renameInExpr(`(text > 'x'::text)`, 'text', 'body')).toBe(`(body > 'x'::text)`);
    // 限定类型名的后半段不是列引用
    expect(E.renameInExpr(`'x'::public."user"`, 'user', '名字')).toBe(`'x'::public."user"`);
    expect(E.renameInExpr(`("user" = 'x'::public."user"[])`, 'user', 'u')).toBe(`(u = 'x'::public."user"[])`);
  });
});

test('类型名规范化', () => {
  const cases: [string, string][] = [
    ['int', 'integer'],
    ['VARCHAR(255)', 'character varying(255)'],
    ['timestamptz', 'timestamp with time zone'],
    ['timestamp(3)', 'timestamp(3) without time zone'],
    ['decimal(10, 2)', 'numeric(10,2)'],
    ['int[]', 'integer[]'],
    ['text [ ]', 'text[]'],
    ['bool', 'boolean'],
    ['uuid', 'uuid'],
    ['public.mood', 'public.mood'],
  ];
  for (const [a, b] of cases) expect(E.normalizeType(a)).toBe(b);
});
