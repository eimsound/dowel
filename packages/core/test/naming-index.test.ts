// Issue #164：命名空间索引的失效点。
// 1. MutableModelIndex 的命名空间分桶在 applyObjectChange / applyBatch（提交）后与全量重建一致，
//    覆盖改表名、改列名、改约束名、删除、表换 schema、MSSQL 改表名（推导 DEFAULT 名随之变化）。
// 2. OverlayModelIndex 开启写入跟踪后的 PG 判重与原扫描实现逐项一致（含分区家族、叠加层改名 / 删除 / 新增）。
import { describe, expect, test } from 'vitest';

import {
  clonePlain,
  type Dialect,
  emptyModel,
  type Model,
  MutableModelIndex,
  type Obj,
  OverlayModelIndex,
  runMutator,
} from '../src/index.ts';
import { nameEntriesOf, type NsEntry } from '../src/naming-ns.ts';

const INT: Record<Dialect, string> = { pg: 'integer', sqlite: 'INTEGER', mysql: 'int', mssql: 'int' };

const entriesOfModel = (m: Model): NsEntry[] => {
  const out: NsEntry[] = [];
  const tableOf = (id: string) => {
    const t = m.objects[id];
    return t?.kind === 'table' ? t : undefined;
  };
  for (const o of Object.values(m.objects)) nameEntriesOf(m.dialect, o, tableOf, out);
  return out;
};

/** 用历次出现过的全部 (命名空间, 名字) 探查：增量索引与全量重建的占用者集合必须相同（也能发现残留的旧条目） */
const expectSameNamespaces = (idx: MutableModelIndex, m: Model, probes: Map<string, NsEntry>) => {
  const fresh = new MutableModelIndex(m);
  for (const e of entriesOfModel(m)) probes.set(`${e.ns}\0${e.name}`, e);
  for (const e of probes.values()) {
    const a = [...(idx.nsOwnersOf(e.ns, e.name)?.entries() ?? [])].sort();
    const b = [...(fresh.nsOwnersOf(e.ns, e.name)?.entries() ?? [])].sort();
    expect(a, `${e.ns.replace('\0', ':')} ${e.name}`).toEqual(b);
  }
};

const buildModel = (dialect: Dialect): Model => {
  const m = emptyModel(dialect);
  const def = { pg: 'public', sqlite: 'main', mysql: 'default', mssql: 'dbo' }[dialect];
  runMutator(m, 'createSchema', { id: 's0', name: def });
  if (dialect === 'pg' || dialect === 'mssql') runMutator(m, 'createSchema', { id: 's1', name: 'other' });
  runMutator(m, 'createTable', { id: 't0', schema: 's0', name: 'orders' });
  runMutator(m, 'addColumn', {
    table: 't0',
    column: {
      id: 'c0',
      name: 'id',
      type: INT[dialect],
      notNull: true,
      ...(dialect === 'mssql' ? { default: { expr: '((0))' } } : {}),
      ...(dialect === 'pg' ? { identity: { always: false } } : {}),
    },
  });
  runMutator(m, 'addColumn', { table: 't0', column: { id: 'c1', name: 'a', type: INT[dialect] } });
  runMutator(m, 'addPrimaryKey', { id: 'pk0', table: 't0', columns: ['c0'] });
  runMutator(m, 'addUnique', { id: 'uq0', table: 't0', columns: ['c1'] });
  runMutator(m, 'addCheck', { id: 'ck0', table: 't0', expr: 'a > 0' });
  runMutator(m, 'addIndex', { id: 'ix0', table: 't0', elements: [{ column: 'c1' }] });
  runMutator(m, 'createTable', { id: 't1', schema: 's0', name: 'items' });
  runMutator(m, 'addColumn', { table: 't1', column: { id: 'c2', name: 'oid', type: INT[dialect] } });
  runMutator(m, 'addForeignKey', {
    id: 'fk0',
    table: 't1',
    columns: ['c2'],
    refTable: 't0',
    refColumns: ['c0'],
  });
  return m;
};

/** 以提交的形式（新对象替换旧对象）应用一组修改，同时增量维护索引 */
const commit = (idx: MutableModelIndex, m: Model, edit: (draft: Model) => void): Model => {
  const draft = clonePlain(m);
  edit(draft);
  const ids = new Set([...Object.keys(m.objects), ...Object.keys(draft.objects)]);
  const batch: { id: string; prev: Obj | undefined; next: Obj | undefined }[] = [];
  for (const id of ids) {
    const prev = m.objects[id];
    const next = draft.objects[id];
    if (JSON.stringify(prev) !== JSON.stringify(next)) batch.push({ id, prev, next });
  }
  idx.applyBatch(draft, batch);
  return draft;
};

describe('MutableModelIndex 命名空间分桶：增量维护与全量重建一致', () => {
  for (const dialect of ['pg', 'sqlite', 'mysql', 'mssql'] as const) {
    test(`${dialect}: 改名 / 删除 / 换 schema / 回放快照`, () => {
      let m = buildModel(dialect);
      const idx = new MutableModelIndex(m);
      const probes = new Map<string, NsEntry>();
      idx.nsOwnersOf('', ''); // 先建好分桶，之后全走增量路径
      expectSameNamespaces(idx, m, probes);
      const steps: ((d: Model) => void)[] = [
        (d) => runMutator(d, 'renameTable', { id: 't0', name: 'orders2' }),
        (d) => runMutator(d, 'renameColumn', { id: 'c0', name: 'ident' }),
        (d) => runMutator(d, 'renameKey', { id: 'ck0', name: 'my_check' }),
        (d) => runMutator(d, 'resetKeyName', { id: 'ck0' }),
        (d) => runMutator(d, 'dropKey', { id: 'uq0' }),
        (d) => runMutator(d, 'addUnique', { id: 'uq1', table: 't1', columns: ['c2'] }),
        // 表换 schema：提交里直接出现（历史恢复 / 外部导入），没有对应的 mutator
        (d) => {
          const t = d.objects.t1;
          if (t?.kind === 'table' && d.objects.s1) t.parent = 's1';
        },
        (d) => runMutator(d, 'dropTable', { id: 't1' }),
        (d) => runMutator(d, 'setNotNull', { id: 'c1', notNull: true }),
        (d) => runMutator(d, 'renameTable', { id: 't0', name: 'orders' }),
      ];
      for (const step of steps) {
        m = commit(idx, m, step);
        expectSameNamespaces(idx, m, probes);
      }
      // 单对象路径（applyObjectChange）
      const draft = clonePlain(m);
      runMutator(draft, 'renameKey', { id: 'ix0', name: 'renamed_ix' });
      idx.applyObjectChange('ix0', m.objects.ix0, draft.objects.ix0);
      idx.setModel(draft);
      expectSameNamespaces(idx, draft, probes);
    });
  }
});

// ───── 写入跟踪的叠加层判重与原扫描实现一致 ─────

describe('OverlayModelIndex 写入跟踪：PG 判重与扫描实现一致', () => {
  test('叠加层新增 / 改名 / 删除，含分区家族', () => {
    const m = emptyModel('pg');
    runMutator(m, 'createSchema', { id: 's0', name: 'public' });
    runMutator(m, 'createTable', { id: 'p', schema: 's0', name: 'p' });
    runMutator(m, 'addColumn', {
      table: 'p',
      column: { id: 'pk', name: 'k', type: 'integer', notNull: true },
    });
    runMutator(m, 'setPartitionBy', {
      id: 'p',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: 'pk', expr: null, opclass: null, collation: null }],
      },
    });
    runMutator(m, 'createPartition', {
      id: 'p1',
      parent: 'p',
      name: 'p_1',
      bound: 'FOR VALUES FROM (0) TO (10)',
    });
    runMutator(m, 'addCheck', { id: 'ck', table: 'p', expr: 'k > 0' });
    runMutator(m, 'createTable', { id: 't', schema: 's0', name: 't' });
    runMutator(m, 'addColumn', {
      table: 't',
      column: { id: 'ta', name: 'a', type: 'integer', notNull: true },
    });
    runMutator(m, 'addUnique', { id: 'tu', table: 't', columns: ['ta'] });
    runMutator(m, 'addIndex', { id: 'ti', table: 't', elements: [{ column: 'ta' }] });
    runMutator(m, 'createEnum', { id: 'e', schema: 's0', name: 'mood', values: ['a'] });

    const base = new MutableModelIndex(m);
    const overlay = new Map<string, Obj | undefined>();
    // 草稿：基线对象 + 叠加层克隆（直接改克隆，再通知跟踪器）
    const draft: Model = { ...m, objects: { ...m.objects } };
    const tracked = new OverlayModelIndex(base, overlay, draft);
    const note = tracked.trackWrites();
    const scan = new OverlayModelIndex(base, overlay, draft);
    const touch = (id: string, f: (o: Obj) => void) => {
      const o = clonePlain(overlay.has(id) ? overlay.get(id)! : m.objects[id]!);
      f(o);
      overlay.set(id, o);
      draft.objects[id] = o;
      note(id);
    };
    const add = (o: Obj) => {
      overlay.set(o.id, o);
      draft.objects[o.id] = o;
      note(o.id);
    };
    const del = (id: string) => {
      overlay.set(id, undefined);
      delete draft.objects[id];
      note(id);
    };

    const names = new Set<string>([
      'p_k_not_null',
      'p_k_check',
      'p_check',
      't_a_key',
      't_a_idx',
      'mood',
      'x',
      'p_1',
    ]);
    const selves = ['', 'ck', 'tu', 'ti', 'pk#nn', 'ta#nn', 'p1', 'new_ck', 'new_ix'];
    const compare = () => {
      for (const o of Object.values(draft.objects)) if ('name' in o) names.add(o.name);
      for (const n of names) {
        for (const self of selves) {
          for (const table of ['p', 'p1', 't']) {
            expect(tracked.isPgConTaken(table, n, self), `con ${table} ${n} ${self}`).toBe(
              scan.isPgConTaken(table, n, self),
            );
          }
          expect(tracked.isPgRelTaken('s0', n, self), `rel ${n} ${self}`).toBe(
            scan.isPgRelTaken('s0', n, self),
          );
          expect(tracked.isPgTypeTaken('s0', n, self), `type ${n} ${self}`).toBe(
            scan.isPgTypeTaken('s0', n, self),
          );
        }
      }
    };

    compare();
    touch('ck', (o) => {
      if (o.kind === 'check') o.name = 'p_check';
    });
    compare();
    add({
      id: 'new_ck',
      kind: 'check',
      parent: 'p1',
      name: 'p_k_check',
      nameMode: 'derived',
      expr: 'k > 1',
      noInherit: false,
      comment: null,
    });
    compare();
    touch('tu', (o) => {
      if (o.kind === 'unique') o.name = 'x';
    });
    touch('ta', (o) => {
      if (o.kind === 'column') o.notNullName = 'p_check';
    });
    compare();
    del('ti');
    touch('t', (o) => {
      if (o.kind === 'table') o.name = 't_a_idx';
    });
    compare();
    add({
      id: 'p2',
      kind: 'table',
      parent: 's0',
      name: 'p_2',
      partitionBy: null,
      partitionOf: { parent: 'p', bound: 'FOR VALUES FROM (10) TO (20)' },
      comment: null,
    });
    add({
      id: 'new_ix',
      kind: 'primaryKey',
      parent: 'p2',
      name: 'p_check',
      nameMode: 'explicit',
      columns: ['pk'],
      comment: null,
    });
    compare();
    del('p1');
    compare();
    expect(tracked.nameTracker()).toBeDefined();
  });
});
