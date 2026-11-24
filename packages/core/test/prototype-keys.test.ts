// #87：模型对象表是普通对象，constructor / toString / valueOf / hasOwnProperty / __proto__
// 这些 Object.prototype 上的名字出现在参数里时，不能被当成已存在的模型对象。
import { describe, expect, test } from 'vitest';

import * as E from '../src/index.ts';

const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

const setup = () => {
  const m = E.emptyModel('pg');
  const s1 = E.createSchema(m, 'public', 's1');
  const t1 = E.createTable(m, s1, 'users', 't1');
  E.addColumn(m, t1, { id: 'c1', name: 'email', type: 'text' });
  return m;
};

describe('readsOf 只收集模型中自有的对象 ID', () => {
  test('表注释为 toString', () => {
    expect(E.readsOf(setup(), { id: 't1', comment: 'toString' })).toEqual(['t1']);
  });

  test('表名为 constructor', () => {
    expect(E.readsOf(setup(), { id: 't1', name: 'constructor' })).toEqual(['t1']);
  });

  test('列名为 valueOf', () => {
    expect(E.readsOf(setup(), { table: 't1', column: { id: 'c2', name: 'valueOf', type: 'text' } })).toEqual([
      't1',
    ]);
  });

  test('枚举值为 hasOwnProperty', () => {
    expect(
      E.readsOf(setup(), { id: 'e1', schema: 's1', name: 'status', values: ['hasOwnProperty'] }),
    ).toEqual(['s1']);
  });

  test('任何原型属性名都不会被收集', () => {
    const m = setup();
    for (const k of PROTO_KEYS)
      expect(E.readsOf(m, { id: 't1', comment: k, name: k, values: [k] })).toEqual(['t1']);
  });
});

describe('原型属性名作为文本参数时 mutator 正常执行', () => {
  test('表名 constructor、列名 valueOf、注释 toString、枚举值 hasOwnProperty', () => {
    const m = setup();
    E.runMutator(m, 'createTable', { id: 't2', schema: 's1', name: 'constructor' });
    E.runMutator(m, 'addColumn', { table: 't2', column: { id: 'c2', name: 'valueOf', type: 'text' } });
    E.runMutator(m, 'setComment', { id: 't2', comment: 'toString' });
    E.runMutator(m, 'createEnum', { id: 'e1', schema: 's1', name: 'status', values: ['hasOwnProperty'] });
    expect(E.get(m, 't2', 'table').name).toBe('constructor');
    expect(E.get(m, 't2', 'table').comment).toBe('toString');
    expect(E.get(m, 'c2', 'column').name).toBe('valueOf');
    expect(E.get(m, 'e1', 'enum').values).toEqual(['hasOwnProperty']);
    expect(E.validate(m)).toEqual([]);
  });

  test('get / find 不把原型属性解析为对象', () => {
    const m = setup();
    for (const k of PROTO_KEYS) {
      expect(() => E.get(m, k)).toThrow(E.EditError);
      expect(E.find(m, k)).toBeUndefined();
    }
  });

  test('原型属性名不能作为对象 ID，且不会污染对象表的原型', () => {
    const m = setup();
    for (const k of PROTO_KEYS) {
      expect(() => E.runMutator(m, 'createTable', { id: k, schema: 's1', name: `x_${k}` })).toThrow(
        E.EditError,
      );
      expect(() => E.createTable(m, 's1', `y_${k}`, k)).toThrow(E.EditError);
    }
    expect(Object.getPrototypeOf(m.objects)).toBe(Object.prototype);
    expect(Object.keys(m.objects).sort()).toEqual(['c1', 's1', 't1']);
  });
});
