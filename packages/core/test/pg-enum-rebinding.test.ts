// PG 规划器：表达式里引用的枚举换了绑定（对调名字、轮换、schema 对调、删后重建、枚举重建）时，
// 引用它的 CHECK / 默认值 / 部分索引 / 表达式索引 / 生成列 / 视图要重建，分区键明确报错（#160）。
import { describe, expect, test } from 'vitest';

import {
  addCheck,
  addColumn,
  addIndex,
  createEnum,
  createSchema,
  createTable,
  emptyModel,
  type Enum,
  type Model,
  type Opaque,
  PlanError,
  plan,
  renameEnum,
  renameSchema,
  type Schema,
  setPartitionBy,
} from '../src/index.ts';
import { remapQualifiedInExpr } from '../src/pg/expr.ts';

const K = `('ok'::public.mood IS NOT NULL)`;
const D = `('ok'::public.mood)::text`;
const G = `('ok'::public.mood < 'sad'::public.mood)`;

/** public.mood('ok','sad') 与 public.tone('ok','sad','meh')，表 t 的 CHECK / 默认值 / 部分索引 / 表达式索引 / 生成列都引用 public.mood */
const base = () => {
  const m = emptyModel();
  const pub = createSchema(m, 'public', 'pub');
  createEnum(m, pub, 'mood', ['ok', 'sad'], 'e1');
  createEnum(m, pub, 'tone', ['ok', 'sad', 'meh'], 'e2');
  const t = createTable(m, pub, 't', 't');
  const id = addColumn(m, t, { name: 'id', type: 'integer', id: 'id' });
  addColumn(m, t, { name: 'k', type: 'text', default: { expr: D }, id: 'k' });
  addColumn(m, t, { name: 'g', type: 'boolean', generated: { expr: G, stored: true }, id: 'g' });
  addCheck(m, t, K, 'st');
  addIndex(m, t, [{ column: id }], { where: K }, 'ix');
  addIndex(m, t, [{ expr: G }], {}, 'ixe');
  return m;
};

/** 直接改名字（不改写表达式）：模型里的表达式文本不变，意思是“绑定到新版本里叫这个名字的那个类型” */
const setName = (m: Model, id: string, name: string) => {
  (m.objects[id] as Enum | Schema).name = name;
};

const sqls = (a: Model, b: Model) => plan(a, b).map((s) => s.sql);

describe('remapQualifiedInExpr', () => {
  const swap = {
    schemas: new Map<string, string>(),
    types: new Map([
      [
        'public',
        new Map([
          ['mood', { schema: 'public', name: 'tone' }],
          ['tone', { schema: 'public', name: 'mood' }],
        ]),
      ],
    ]),
  };

  test('对调两个名字时一趟替换，不会互相抵消', () => {
    expect(remapQualifiedInExpr(`'a'::public.mood = 'b'::public.tone`, swap)).toBe(
      `'a'::public.tone = 'b'::public.mood`,
    );
  });

  test('三方轮换、带引号名字、字符串字面量里的同名文本不受影响', () => {
    const r = {
      schemas: new Map<string, string>(),
      types: new Map([
        [
          'public',
          new Map([
            ['a', { schema: 'public', name: 'b' }],
            ['b', { schema: 'public', name: 'C' }],
            ['C', { schema: 'public', name: 'a' }],
          ]),
        ],
      ]),
    };
    expect(remapQualifiedInExpr(`f('public.a', 'x'::public.a, 'y'::public.b, 'z'::"public"."C")`, r)).toBe(
      `f('public.a', 'x'::public.b, 'y'::public."C", 'z'::public.a)`,
    );
  });

  test('schema 对调：限定名的 schema 部分一趟替换', () => {
    const r = {
      schemas: new Map([
        ['a', 'b'],
        ['b', 'a'],
      ]),
      types: new Map<string, Map<string, { schema: string; name: string }>>(),
    };
    expect(remapQualifiedInExpr(`a.f(x) + b.g(y)`, r)).toBe(`b.f(x) + a.g(y)`);
  });
});

describe('PG 规划器：枚举换绑定时重建引用它的表达式对象（#160）', () => {
  test('两个枚举对调名字：重建 CHECK、默认值、部分索引、表达式索引、生成列，按新名字绑定', () => {
    const a = base();
    const b = structuredClone(a);
    setName(b, 'e1', 'tone');
    setName(b, 'e2', 'mood');
    const s = sqls(a, b);
    expect(s).toEqual(
      expect.arrayContaining([
        'ALTER TABLE public.t DROP CONSTRAINT t_check',
        'DROP INDEX public.t_id_idx',
        'DROP INDEX public.t_expr_idx',
        'ALTER TABLE public.t DROP COLUMN g',
        'ALTER TABLE public.t ALTER COLUMN k DROP DEFAULT',
        `ALTER TABLE public.t ALTER COLUMN k SET DEFAULT ${D}`,
        `ALTER TABLE public.t ADD COLUMN g boolean GENERATED ALWAYS AS (${G}) STORED`,
        `ALTER TABLE public.t ADD CONSTRAINT t_check CHECK (${K})`,
        `CREATE INDEX t_id_idx ON public.t USING btree (id) WHERE ${K}`,
        `CREATE INDEX t_expr_idx ON public.t USING btree ((${G}))`,
      ]),
    );
    // 先拆掉、再改名、再按新名字重建
    const renameAt = s.findIndex((x) => x.startsWith('ALTER TYPE'));
    expect(s.indexOf('ALTER TABLE public.t DROP CONSTRAINT t_check')).toBeLessThan(renameAt);
    expect(s.indexOf(`ALTER TABLE public.t ADD CONSTRAINT t_check CHECK (${K})`)).toBeGreaterThan(
      s.findLastIndex((x) => x.startsWith('ALTER TYPE')),
    );
    expect(s.indexOf(`ALTER TABLE public.t ALTER COLUMN k SET DEFAULT ${D}`)).toBeGreaterThan(renameAt);
    // 反向迁移同样重建
    expect(sqls(b, a)).toEqual(
      expect.arrayContaining([`ALTER TABLE public.t ADD CONSTRAINT t_check CHECK (${K})`]),
    );
  });

  test('三个枚举轮换名字同样重建', () => {
    const a = base();
    createEnum(a, 'pub', 'hue', ['ok', 'sad'], 'e3');
    const b = structuredClone(a);
    setName(b, 'e1', 'tone');
    setName(b, 'e2', 'hue');
    setName(b, 'e3', 'mood');
    const s = sqls(a, b);
    expect(s).toEqual(expect.arrayContaining([`ALTER TABLE public.t ADD CONSTRAINT t_check CHECK (${K})`]));
    expect(s).toEqual(expect.arrayContaining([`ALTER TABLE public.t ALTER COLUMN k SET DEFAULT ${D}`]));
  });

  test('只是改名（表达式跟着改写）：绑定没变，不重建', () => {
    const a = base();
    const b = structuredClone(a);
    renameEnum(b, 'e1', 'feeling');
    expect(sqls(a, b)).toEqual(['ALTER TYPE public.mood RENAME TO feeling']);
  });

  test('用改名操作对调两个枚举（表达式跟着旧类型走）：绑定没变，只改名', () => {
    const a = base();
    const b = structuredClone(a);
    renameEnum(b, 'e1', 'x');
    renameEnum(b, 'e2', 'mood');
    renameEnum(b, 'e1', 'tone');
    const s = sqls(a, b);
    expect(s.every((x) => x.startsWith('ALTER TYPE'))).toBe(true);
  });

  test('两个 schema 对调名字：引用 schema 限定枚举的表达式重建', () => {
    const m = emptyModel();
    const sa = createSchema(m, 'a', 'sa');
    const sb = createSchema(m, 'b', 'sb');
    createEnum(m, sa, 'mood', ['ok'], 'ea');
    createEnum(m, sb, 'mood', ['ok'], 'eb');
    const t = createTable(m, sa, 't', 't');
    addColumn(m, t, { name: 'id', type: 'integer', id: 'id' });
    addCheck(m, t, `('ok'::a.mood IS NOT NULL)`, 'st');
    const b = structuredClone(m);
    setName(b, 'sa', 'b');
    setName(b, 'sb', 'a');
    const s = sqls(m, b);
    expect(s).toContain(`ALTER TABLE b.t ADD CONSTRAINT t_check CHECK (('ok'::a.mood IS NOT NULL))`);
    // 用 renameSchema 对调（表达式跟着改写）：不重建
    const c = structuredClone(m);
    renameSchema(c, 'sa', 'x');
    renameSchema(c, 'sb', 'a');
    renameSchema(c, 'sa', 'b');
    expect(sqls(m, c).every((x) => x.startsWith('ALTER SCHEMA'))).toBe(true);
  });

  test('删掉枚举再建同名枚举（只被表达式引用）：删旧类型之前先拆依赖，之后按新类型重建', () => {
    const a = base();
    const b = structuredClone(a);
    delete b.objects.e1;
    createEnum(b, 'pub', 'mood', ['ok', 'sad', 'new'], 'e9');
    const s = sqls(a, b);
    const dropType = s.indexOf('DROP TYPE public._dowel_tmp_1');
    expect(dropType).toBeGreaterThan(0);
    for (const x of [
      'ALTER TABLE public.t DROP CONSTRAINT t_check',
      'DROP INDEX public.t_id_idx',
      'DROP INDEX public.t_expr_idx',
      'ALTER TABLE public.t DROP COLUMN g',
      'ALTER TABLE public.t ALTER COLUMN k DROP DEFAULT',
    ])
      expect(s.indexOf(x), x).toBeLessThan(dropType);
    expect(s.indexOf(`CREATE TYPE public.mood AS ENUM ('ok', 'sad', 'new')`)).toBeLessThan(
      s.indexOf(`ALTER TABLE public.t ALTER COLUMN k SET DEFAULT ${D}`),
    );
    expect(s).toContain(`ALTER TABLE public.t ADD CONSTRAINT t_check CHECK (${K})`);
  });

  test('枚举重建（删值）时，非枚举列上引用它的默认值在删旧类型之前去掉', () => {
    const a = base();
    const b = structuredClone(a);
    (b.objects.e1 as Enum).values = ['sad', 'ok'];
    const s = sqls(a, b);
    const dropType = s.findIndex((x) => /^DROP TYPE public\._dowel_tmp_\d+$/.test(x));
    expect(s.indexOf('ALTER TABLE public.t ALTER COLUMN k DROP DEFAULT')).toBeLessThan(dropType);
    expect(s.indexOf('ALTER TABLE public.t DROP COLUMN g')).toBeLessThan(dropType);
    expect(s.indexOf(`ALTER TABLE public.t ALTER COLUMN k SET DEFAULT ${D}`)).toBeGreaterThan(dropType);
  });

  test('分区键表达式引用了换绑定的枚举：明确报错', () => {
    const m = emptyModel();
    const pub = createSchema(m, 'public', 'pub');
    createEnum(m, pub, 'mood', ['ok', 'sad'], 'e1');
    createEnum(m, pub, 'tone', ['ok', 'sad'], 'e2');
    const p = createTable(m, pub, 'p', 'p');
    addColumn(m, p, { name: 'id', type: 'integer', id: 'id' });
    setPartitionBy(m, p, {
      strategy: 'list',
      keys: [{ column: null, expr: `(id > 0) = ${G}`, opclass: null, collation: null }],
    });
    const b = structuredClone(m);
    setName(b, 'e1', 'tone');
    setName(b, 'e2', 'mood');
    expect(() => plan(m, b)).toThrow(PlanError);
    expect(() => plan(m, b)).toThrow(/分区键表达式引用了枚举 public\.mood/);
    // 只改名不报错
    const c = structuredClone(m);
    renameEnum(c, 'e1', 'feeling');
    expect(sqls(m, c)).toEqual(['ALTER TYPE public.mood RENAME TO feeling']);
  });

  test('视图：依赖的枚举换成另一个（按 ID）时删掉重建；依赖不变只改名时不动', () => {
    const a = base();
    const view: Opaque = {
      id: 'v',
      kind: 'opaque',
      objType: 'view',
      parent: 'pub',
      name: 'v',
      ddl: [`CREATE VIEW public.v AS SELECT 'ok'::public.mood AS x`],
      drop: 'DROP VIEW public.v',
      deps: ['e1'],
      order: 1,
      comment: null,
    };
    a.objects.v = view;
    const b = structuredClone(a);
    setName(b, 'e1', 'tone');
    setName(b, 'e2', 'mood');
    (b.objects.v as Opaque).deps = ['e2'];
    const s = sqls(a, b);
    expect(s).toContain('DROP VIEW public.v');
    expect(s.indexOf(`CREATE VIEW public.v AS SELECT 'ok'::public.mood AS x`)).toBeGreaterThan(
      s.findLastIndex((x) => x.startsWith('ALTER TYPE')),
    );
    const c = structuredClone(a);
    renameEnum(c, 'e1', 'feeling');
    expect(sqls(a, c)).toEqual(['ALTER TYPE public.mood RENAME TO feeling']);
  });
});
