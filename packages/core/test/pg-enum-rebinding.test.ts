// PG 规划器：表达式里引用的枚举换了绑定（对调名字、轮换、schema 对调、删后重建、枚举重建）时，
// 引用它的 CHECK / 默认值 / 部分索引 / 表达式索引 / 生成列 / 视图要重建，分区键明确报错（#160）。
import { describe, expect, test } from 'vitest';

import {
  addCheck,
  addColumn,
  addIndex,
  createEnum,
  createPartition,
  createSchema,
  createTable,
  detachPartition,
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
const at = (s: string[], sql: string): number => {
  const i = s.indexOf(sql);
  expect(i, `期望生成语句：${sql}`).toBeGreaterThanOrEqual(0);
  return i;
};

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
    // 限定名的后半段（复合类型字段访问）不是 schema
    expect(remapQualifiedInExpr(`(rec).a.b + t.a.b`, r)).toBe(`(rec).a.b + t.a.b`);
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
    const lastRename = s.findLastIndex((x) => x.startsWith('ALTER TYPE'));
    expect(renameAt).toBeGreaterThanOrEqual(0);
    expect(lastRename).toBeGreaterThanOrEqual(renameAt);
    expect(at(s, 'ALTER TABLE public.t DROP CONSTRAINT t_check')).toBeLessThan(renameAt);
    expect(at(s, 'DROP INDEX public.t_id_idx')).toBeLessThan(renameAt);
    expect(at(s, 'DROP INDEX public.t_expr_idx')).toBeLessThan(renameAt);
    expect(at(s, 'ALTER TABLE public.t DROP COLUMN g')).toBeLessThan(renameAt);
    expect(at(s, `ALTER TABLE public.t ALTER COLUMN k SET DEFAULT ${D}`)).toBeGreaterThan(lastRename);
    expect(
      at(s, `ALTER TABLE public.t ADD COLUMN g boolean GENERATED ALWAYS AS (${G}) STORED`),
    ).toBeGreaterThan(lastRename);
    expect(at(s, `ALTER TABLE public.t ADD CONSTRAINT t_check CHECK (${K})`)).toBeGreaterThan(lastRename);
    expect(at(s, `CREATE INDEX t_id_idx ON public.t USING btree (id) WHERE ${K}`)).toBeGreaterThan(
      lastRename,
    );
    expect(at(s, `CREATE INDEX t_expr_idx ON public.t USING btree ((${G}))`)).toBeGreaterThan(lastRename);
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
    const dropType = at(s, 'DROP TYPE public._dowel_tmp_1');
    for (const x of [
      'ALTER TABLE public.t DROP CONSTRAINT t_check',
      'DROP INDEX public.t_id_idx',
      'DROP INDEX public.t_expr_idx',
      'ALTER TABLE public.t DROP COLUMN g',
      'ALTER TABLE public.t ALTER COLUMN k DROP DEFAULT',
    ])
      expect(at(s, x), x).toBeLessThan(dropType);
    expect(at(s, `CREATE TYPE public.mood AS ENUM ('ok', 'sad', 'new')`)).toBeLessThan(
      at(s, `ALTER TABLE public.t ALTER COLUMN k SET DEFAULT ${D}`),
    );
    expect(s).toContain(`ALTER TABLE public.t ADD CONSTRAINT t_check CHECK (${K})`);
  });

  test('枚举重建（删值）时，非枚举列上引用它的默认值与全部依赖表达式在删旧类型之前拆掉、之后按新类型重建', () => {
    const a = base();
    const b = structuredClone(a);
    (b.objects.e1 as Enum).values = ['sad', 'ok'];
    const s = sqls(a, b);
    const dropType = s.findIndex((x) => /^DROP TYPE public\._dowel_tmp_\d+$/.test(x));
    expect(dropType).toBeGreaterThanOrEqual(0);
    for (const x of [
      'ALTER TABLE public.t DROP CONSTRAINT t_check',
      'DROP INDEX public.t_id_idx',
      'DROP INDEX public.t_expr_idx',
      'ALTER TABLE public.t DROP COLUMN g',
      'ALTER TABLE public.t ALTER COLUMN k DROP DEFAULT',
    ])
      expect(at(s, x), x).toBeLessThan(dropType);
    for (const x of [
      `ALTER TABLE public.t ALTER COLUMN k SET DEFAULT ${D}`,
      `ALTER TABLE public.t ADD COLUMN g boolean GENERATED ALWAYS AS (${G}) STORED`,
      `ALTER TABLE public.t ADD CONSTRAINT t_check CHECK (${K})`,
      `CREATE INDEX t_id_idx ON public.t USING btree (id) WHERE ${K}`,
      `CREATE INDEX t_expr_idx ON public.t USING btree ((${G}))`,
    ])
      expect(at(s, x), x).toBeGreaterThan(dropType);
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
    const firstRename = s.findIndex((x) => x.startsWith('ALTER TYPE'));
    const lastRename = s.findLastIndex((x) => x.startsWith('ALTER TYPE'));
    expect(firstRename).toBeGreaterThanOrEqual(0);
    expect(lastRename).toBeGreaterThanOrEqual(firstRename);
    expect(at(s, 'DROP VIEW public.v')).toBeLessThan(firstRename);
    expect(at(s, `CREATE VIEW public.v AS SELECT 'ok'::public.mood AS x`)).toBeGreaterThan(lastRename);
    const c = structuredClone(a);
    renameEnum(c, 'e1', 'feeling');
    expect(sqls(a, c)).toEqual(['ALTER TYPE public.mood RENAME TO feeling']);
  });

  describe('枚举重建（删值 / 重排值）时，类型是该枚举的列', () => {
    const enumColModel = () => {
      const m = emptyModel();
      const pub = createSchema(m, 'public', 'pub');
      createEnum(m, pub, 'mood', ['ok', 'sad'], 'e1');
      const t = createTable(m, pub, 't', 't');
      addColumn(m, t, { name: 'id', type: 'integer', id: 'id' });
      addColumn(m, t, { name: 'm', type: '', typeRef: 'e1', id: 'm' });
      return m;
    };
    const reorder = (m: Model) => {
      const b = structuredClone(m);
      (b.objects.e1 as Enum).values = ['sad', 'ok'];
      return b;
    };

    test('引用它的生成列先删、改完类型再加回', () => {
      const m = enumColModel();
      addColumn(m, 't', {
        name: 'g',
        type: 'boolean',
        generated: { expr: '(m IS NULL)', stored: true },
        id: 'g',
      });
      const s = sqls(m, reorder(m));
      const alter = s.findIndex((x) => x.includes('ALTER COLUMN m TYPE'));
      expect(alter).toBeGreaterThanOrEqual(0);
      expect(at(s, 'ALTER TABLE public.t DROP COLUMN g')).toBeLessThan(alter);
      expect(
        at(s, 'ALTER TABLE public.t ADD COLUMN g boolean GENERATED ALWAYS AS ((m IS NULL)) STORED'),
      ).toBeGreaterThan(alter);
    });

    test('依赖它的视图删掉重建', () => {
      const m = enumColModel();
      m.objects.v = {
        id: 'v',
        kind: 'opaque',
        objType: 'view',
        parent: 'pub',
        name: 'v',
        ddl: ['CREATE VIEW public.v AS SELECT m FROM public.t'],
        drop: 'DROP VIEW public.v',
        deps: ['t', 'm'],
        order: 1,
        comment: null,
      };
      const s = sqls(m, reorder(m));
      const alter = s.findIndex((x) => x.includes('ALTER COLUMN m TYPE'));
      expect(alter).toBeGreaterThanOrEqual(0);
      expect(at(s, 'DROP VIEW public.v')).toBeLessThan(alter);
      expect(at(s, 'CREATE VIEW public.v AS SELECT m FROM public.t')).toBeGreaterThan(alter);
    });

    test('它是分区键列：明确报错', () => {
      const m = enumColModel();
      setPartitionBy(m, 't', {
        strategy: 'list',
        keys: [{ column: 'm', expr: null, opclass: null, collation: null }],
      });
      expect(() => plan(m, reorder(m))).toThrow(/分区键引用，它的枚举类型要删值或重排值/);
    });
  });

  test('枚举同时改名并删值时，P8 按旧名字匹配并先去掉引用它的文本列默认值（防 M13）', () => {
    const a = emptyModel();
    const pub = createSchema(a, 'public', 'pub');
    createEnum(a, pub, 'mood', ['ok', 'sad', 'extra'], 'e1');
    const t = createTable(a, pub, 't', 't');
    const id = addColumn(a, t, { name: 'id', type: 'integer', id: 'id' });
    addColumn(a, t, { name: 'k', type: 'text', default: { expr: D }, id: 'k' });
    addColumn(a, t, { name: 'g', type: 'boolean', generated: { expr: G, stored: true }, id: 'g' });
    addCheck(a, t, K, 'st');
    addIndex(a, t, [{ column: id }], { where: K }, 'ix');
    addIndex(a, t, [{ expr: G }], {}, 'ixe');

    const b = structuredClone(a);
    renameEnum(b, 'e1', 'feeling');
    (b.objects.e1 as Enum).values = ['ok', 'sad'];

    const s = sqls(a, b);
    const dropType = s.findIndex((x) => /^DROP TYPE public\._dowel_tmp_\d+$/.test(x));
    expect(dropType).toBeGreaterThanOrEqual(0);
    expect(at(s, 'ALTER TABLE public.t ALTER COLUMN k DROP DEFAULT')).toBeLessThan(dropType);
    expect(at(s, 'ALTER TABLE public.t DROP COLUMN g')).toBeLessThan(dropType);
    expect(
      at(s, "ALTER TABLE public.t ALTER COLUMN k SET DEFAULT ('ok'::public.feeling)::text"),
    ).toBeGreaterThan(dropType);
  });

  test('对调枚举名字的同时把子分区脱离成独立表：子分区上的默认值也必须重设（防 M12）', () => {
    const a = emptyModel();
    const pub = createSchema(a, 'public', 'pub');
    createEnum(a, pub, 'mood', ['ok', 'sad'], 'e1');
    createEnum(a, pub, 'tone', ['ok', 'sad', 'meh'], 'e2');
    const p = createTable(a, pub, 'p', 'p');
    const id = addColumn(a, p, { name: 'id', type: 'integer', id: 'id' });
    addColumn(a, p, { name: 'k', type: 'text', default: { expr: D }, id: 'k' });
    setPartitionBy(a, p, {
      strategy: 'range',
      keys: [{ column: id, expr: null, opclass: null, collation: null }],
    });
    createPartition(a, p, 'p1', 'FOR VALUES FROM (0) TO (100)', 'p1');

    const b = structuredClone(a);
    detachPartition(b, 'p1');
    setName(b, 'e1', 'tone');
    setName(b, 'e2', 'mood');

    const s = sqls(a, b);
    const detachAt = at(s, 'ALTER TABLE public.p DETACH PARTITION public.p1');
    const lastRename = s.findLastIndex((x) => x.startsWith('ALTER TYPE'));
    expect(lastRename).toBeGreaterThanOrEqual(0);
    const dropDef = at(s, 'ALTER TABLE public.p1 ALTER COLUMN k DROP DEFAULT');
    const setDef = at(s, `ALTER TABLE public.p1 ALTER COLUMN k SET DEFAULT ${D}`);
    expect(detachAt).toBeLessThan(dropDef);
    expect(lastRename).toBeLessThan(dropDef);
    expect(dropDef).toBeLessThan(setDef);
  });

  test('早期不透明对象（函数签名）依赖的枚举被删掉重建：明确报错，不在执行时才失败', () => {
    const a = base();
    a.objects.f = {
      id: 'f',
      kind: 'opaque',
      objType: 'function',
      parent: 'pub',
      name: 'f(public.mood)',
      ddl: [
        'CREATE OR REPLACE FUNCTION public.f(x public.mood) RETURNS integer LANGUAGE sql IMMUTABLE AS $$select 1$$',
      ],
      drop: 'DROP FUNCTION public.f(public.mood)',
      deps: ['e1'],
      order: 1,
      comment: null,
    };
    const b = structuredClone(a);
    delete b.objects.e1;
    createEnum(b, 'pub', 'mood', ['ok', 'sad'], 'e9');
    (b.objects.f as Opaque).deps = ['e9'];
    expect(() => plan(a, b)).toThrow(/函数 f\(public\.mood\) 依赖的枚举 public\.mood/);
    // 只改名不受影响
    const c = structuredClone(a);
    renameEnum(c, 'e1', 'feeling');
    expect(sqls(a, c)).toEqual(['ALTER TYPE public.mood RENAME TO feeling']);
  });
});

describe('早期不透明对象依赖被删或重建枚举时的规划规则', () => {
  const withEnumAndOpaque = (opaque: Opaque) => {
    const m = emptyModel();
    const pub = createSchema(m, 'public', 'pub');
    createEnum(m, pub, 'gone', ['x', 'y'], 'e_gone');
    m.objects[opaque.id] = opaque;
    return m;
  };

  test('domain 依赖被删枚举：改成不依赖该枚举或一并删除时允许，未改仍依赖时报错', () => {
    const domainObj: Opaque = {
      id: 'd1',
      kind: 'opaque',
      objType: 'domain',
      parent: 'pub',
      name: 'd',
      ddl: ['CREATE DOMAIN public.d AS public.gone'],
      drop: 'DROP DOMAIN public.d',
      deps: ['e_gone'],
      order: 1,
      comment: null,
    };
    const m1 = withEnumAndOpaque(domainObj);

    // 1) 域重定义为不再依赖该枚举（AS text）+ 同版本删除枚举：允许，P8b 删建域早于 P14 删枚举
    const redefinedAway = structuredClone(m1);
    delete redefinedAway.objects.e_gone;
    (redefinedAway.objects.d1 as Opaque).ddl = ['CREATE DOMAIN public.d AS text'];
    (redefinedAway.objects.d1 as Opaque).deps = [];
    const up = sqls(m1, redefinedAway);
    expect(at(up, 'DROP DOMAIN public.d')).toBeLessThan(at(up, 'CREATE DOMAIN public.d AS text'));
    expect(at(up, 'CREATE DOMAIN public.d AS text')).toBeLessThan(at(up, 'DROP TYPE public.gone'));
    const down = sqls(redefinedAway, m1);
    expect(at(down, "CREATE TYPE public.gone AS ENUM ('x', 'y')")).toBeLessThan(
      at(down, 'DROP DOMAIN public.d'),
    );
    expect(at(down, 'DROP DOMAIN public.d')).toBeLessThan(at(down, 'CREATE DOMAIN public.d AS public.gone'));

    // 2) 域与枚举同版本一并删除：允许，先删域再删枚举
    const bothDropped = structuredClone(m1);
    delete bothDropped.objects.e_gone;
    delete bothDropped.objects.d1;
    const dropSqls = sqls(m1, bothDropped);
    expect(at(dropSqls, 'DROP DOMAIN public.d')).toBeLessThan(at(dropSqls, 'DROP TYPE public.gone'));

    // 3) 域未改动（仍依赖被删枚举）：报错
    const unchanged = structuredClone(m1);
    delete unchanged.objects.e_gone;
    expect(() => plan(m1, unchanged)).toThrow(PlanError);
    expect(() => plan(m1, unchanged)).toThrow(/域 d 依赖的枚举 public\.gone/);

    // 4) 枚举被删后重建同名枚举，域也改写为继续依赖新枚举：报错
    const recreatedStillDep = structuredClone(m1);
    delete recreatedStillDep.objects.e_gone;
    createEnum(recreatedStillDep, 'pub', 'gone', ['x', 'y'], 'e_new');
    (recreatedStillDep.objects.d1 as Opaque).ddl = ['CREATE DOMAIN public.d AS public.gone NOT NULL'];
    (recreatedStillDep.objects.d1 as Opaque).deps = ['e_new'];
    expect(() => plan(m1, recreatedStillDep)).toThrow(PlanError);
    expect(() => plan(m1, recreatedStillDep)).toThrow(/域 d 依赖的枚举 public\.gone/);

    // 5) 枚举被删后重建同名枚举，但域改为不再依赖它（AS text）：允许
    const recreatedRedefinedAway = structuredClone(recreatedStillDep);
    (recreatedRedefinedAway.objects.d1 as Opaque).ddl = ['CREATE DOMAIN public.d AS text'];
    (recreatedRedefinedAway.objects.d1 as Opaque).deps = [];
    const upRec = sqls(m1, recreatedRedefinedAway);
    expect(at(upRec, 'DROP DOMAIN public.d')).toBeLessThan(at(upRec, 'CREATE DOMAIN public.d AS text'));
    expect(at(upRec, 'CREATE DOMAIN public.d AS text')).toBeLessThan(
      at(upRec, 'DROP TYPE public._dowel_tmp_1'),
    );

    // 6) 枚举原地重建（重排值）：即使域重定义或删除，仍报错（P8 在 P8b / P14 之前删旧类型）
    const rebuiltAway = structuredClone(m1);
    (rebuiltAway.objects.e_gone as Enum).values = ['y', 'x'];
    (rebuiltAway.objects.d1 as Opaque).ddl = ['CREATE DOMAIN public.d AS text'];
    (rebuiltAway.objects.d1 as Opaque).deps = [];
    expect(() => plan(m1, rebuiltAway)).toThrow(PlanError);
    const rebuiltDropped = structuredClone(m1);
    (rebuiltDropped.objects.e_gone as Enum).values = ['y', 'x'];
    delete rebuiltDropped.objects.d1;
    expect(() => plan(m1, rebuiltDropped)).toThrow(PlanError);
  });

  test('复合类型（type）依赖被删枚举：改成不依赖该枚举或一并删除时允许，未改仍依赖时报错', () => {
    const compObj: Opaque = {
      id: 't1',
      kind: 'opaque',
      objType: 'type',
      parent: 'pub',
      name: 'c',
      ddl: ['CREATE TYPE public.c AS (a public.gone, b integer)'],
      drop: 'DROP TYPE public.c',
      deps: ['e_gone'],
      order: 1,
      comment: null,
    };
    const m1 = withEnumAndOpaque(compObj);

    const redefinedAway = structuredClone(m1);
    delete redefinedAway.objects.e_gone;
    (redefinedAway.objects.t1 as Opaque).ddl = ['CREATE TYPE public.c AS (a text, b integer)'];
    (redefinedAway.objects.t1 as Opaque).deps = [];
    const up = sqls(m1, redefinedAway);
    expect(at(up, 'DROP TYPE public.c')).toBeLessThan(at(up, 'CREATE TYPE public.c AS (a text, b integer)'));
    expect(at(up, 'CREATE TYPE public.c AS (a text, b integer)')).toBeLessThan(
      at(up, 'DROP TYPE public.gone'),
    );

    const bothDropped = structuredClone(m1);
    delete bothDropped.objects.e_gone;
    delete bothDropped.objects.t1;
    const dropSqls = sqls(m1, bothDropped);
    expect(at(dropSqls, 'DROP TYPE public.c')).toBeLessThan(at(dropSqls, 'DROP TYPE public.gone'));

    const unchanged = structuredClone(m1);
    delete unchanged.objects.e_gone;
    expect(() => plan(m1, unchanged)).toThrow(PlanError);
    expect(() => plan(m1, unchanged)).toThrow(/复合类型 c 依赖的枚举 public\.gone/);
  });

  test('函数签名依赖被删枚举：改成不依赖、拆删建或一并删除时允许，未改或枚举同名重建时报错', () => {
    const fnParam: Opaque = {
      id: 'f1',
      kind: 'opaque',
      objType: 'function',
      parent: 'pub',
      name: 'f(public.gone)',
      ddl: [
        'CREATE OR REPLACE FUNCTION public.f(x public.gone) RETURNS integer LANGUAGE sql IMMUTABLE AS $$select 1$$',
      ],
      drop: 'DROP FUNCTION public.f(public.gone)',
      deps: ['e_gone'],
      order: 1,
      comment: null,
    };
    const mParam = withEnumAndOpaque(fnParam);

    // 1) 同 ID 改参数签名（并更新 name / drop）：先 DROP 旧函数，再 CREATE 新函数，最后 DROP TYPE
    const paramAway = structuredClone(mParam);
    delete paramAway.objects.e_gone;
    (paramAway.objects.f1 as Opaque).name = 'f(text)';
    (paramAway.objects.f1 as Opaque).ddl = [
      'CREATE OR REPLACE FUNCTION public.f(x text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$select 1$$',
    ];
    (paramAway.objects.f1 as Opaque).drop = 'DROP FUNCTION public.f(text)';
    (paramAway.objects.f1 as Opaque).deps = [];
    const upParam = sqls(mParam, paramAway);
    expect(at(upParam, 'DROP FUNCTION public.f(public.gone)')).toBeLessThan(
      at(
        upParam,
        'CREATE OR REPLACE FUNCTION public.f(x text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$select 1$$',
      ),
    );
    expect(
      at(
        upParam,
        'CREATE OR REPLACE FUNCTION public.f(x text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$select 1$$',
      ),
    ).toBeLessThan(at(upParam, 'DROP TYPE public.gone'));
    const downParam = sqls(paramAway, mParam);
    expect(at(downParam, "CREATE TYPE public.gone AS ENUM ('x', 'y')")).toBeLessThan(
      at(downParam, 'DROP FUNCTION public.f(text)'),
    );
    expect(at(downParam, 'DROP FUNCTION public.f(text)')).toBeLessThan(
      at(
        downParam,
        'CREATE OR REPLACE FUNCTION public.f(x public.gone) RETURNS integer LANGUAGE sql IMMUTABLE AS $$select 1$$',
      ),
    );

    // 2) 同 ID 改返回类型（name / drop 不变，RETURNS 从 public.gone 改为 text）
    const fnRet: Opaque = {
      id: 'f_ret',
      kind: 'opaque',
      objType: 'function',
      parent: 'pub',
      name: 'f_ret(integer)',
      ddl: [
        "CREATE OR REPLACE FUNCTION public.f_ret(x integer) RETURNS public.gone LANGUAGE sql IMMUTABLE AS $$select 'x'::public.gone$$",
      ],
      drop: 'DROP FUNCTION public.f_ret(integer)',
      deps: ['e_gone'],
      order: 1,
      comment: null,
    };
    const mRet = withEnumAndOpaque(fnRet);
    const retAway = structuredClone(mRet);
    delete retAway.objects.e_gone;
    (retAway.objects.f_ret as Opaque).ddl = [
      "CREATE OR REPLACE FUNCTION public.f_ret(x integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$select 'x'::text$$",
    ];
    (retAway.objects.f_ret as Opaque).deps = [];
    const upRet = sqls(mRet, retAway);
    expect(at(upRet, 'DROP FUNCTION public.f_ret(integer)')).toBeLessThan(
      at(
        upRet,
        "CREATE OR REPLACE FUNCTION public.f_ret(x integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$select 'x'::text$$",
      ),
    );
    expect(
      at(
        upRet,
        "CREATE OR REPLACE FUNCTION public.f_ret(x integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$select 'x'::text$$",
      ),
    ).toBeLessThan(at(upRet, 'DROP TYPE public.gone'));

    // 3) 仅改函数体、签名不变时不发 DROP FUNCTION
    const bodyOnly = structuredClone(mParam);
    delete bodyOnly.objects.e_gone;
    const mBody0 = structuredClone(mParam);
    (mBody0.objects.f1 as Opaque).deps = [];
    const mBody1 = structuredClone(mBody0);
    (mBody1.objects.f1 as Opaque).ddl = [
      'CREATE OR REPLACE FUNCTION public.f(x public.gone) RETURNS integer LANGUAGE sql IMMUTABLE AS $$select 2$$',
    ];
    expect(sqls(mBody0, mBody1)).toEqual([
      'CREATE OR REPLACE FUNCTION public.f(x public.gone) RETURNS integer LANGUAGE sql IMMUTABLE AS $$select 2$$',
    ]);

    // 4) 不同 ID（删 f(public.gone) + 新建 f(text)）：允许，先 DROP FUNCTION 再 DROP TYPE
    const diffIds = structuredClone(mParam);
    delete diffIds.objects.e_gone;
    delete diffIds.objects.f1;
    diffIds.objects.f2 = {
      id: 'f2',
      kind: 'opaque',
      objType: 'function',
      parent: 'pub',
      name: 'f(text)',
      ddl: [
        'CREATE OR REPLACE FUNCTION public.f(x text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$select 1$$',
      ],
      drop: 'DROP FUNCTION public.f(text)',
      deps: [],
      order: 1,
      comment: null,
    };
    const upDiffIds = sqls(mParam, diffIds);
    expect(at(upDiffIds, 'DROP FUNCTION public.f(public.gone)')).toBeLessThan(
      at(upDiffIds, 'DROP TYPE public.gone'),
    );

    // 5) 函数与枚举一并删除：允许，先 DROP FUNCTION 再 DROP TYPE
    const bothDropped = structuredClone(mParam);
    delete bothDropped.objects.e_gone;
    delete bothDropped.objects.f1;
    const dropSqls = sqls(mParam, bothDropped);
    expect(at(dropSqls, 'DROP FUNCTION public.f(public.gone)')).toBeLessThan(
      at(dropSqls, 'DROP TYPE public.gone'),
    );

    // 6) 函数未改动（仍依赖被删枚举）：报错
    const unchanged = structuredClone(mParam);
    delete unchanged.objects.e_gone;
    expect(() => plan(mParam, unchanged)).toThrow(PlanError);
    expect(() => plan(mParam, unchanged)).toThrow(/函数 f\(public\.gone\) 依赖的枚举 public\.gone/);

    // 7) 枚举被删并重建同名枚举时，即使函数被删或改走，仍报错（P6 改临时名会破坏静态 DROP FUNCTION 签名）
    const recreatedDropFn = structuredClone(mParam);
    delete recreatedDropFn.objects.e_gone;
    delete recreatedDropFn.objects.f1;
    createEnum(recreatedDropFn, 'pub', 'gone', ['x', 'y'], 'e_new');
    expect(() => plan(mParam, recreatedDropFn)).toThrow(PlanError);
  });
});
