// Issue #165：OverlayModelIndex 的叠加层分桶与 SQLite / MySQL / MSSQL 的命名空间判重。
// 1. 开启写入跟踪时增量维护的分桶，与未跟踪时每次从头折叠、以及直接过滤草稿模型的结果一致
//    （覆盖新增、删除、原地改 parent / partitionOf / ownedBy、先建后删、只通知不写入）。
// 2. isNameTaken 的命名空间快路径（基线 MutableModelIndex、跟踪中的叠加索引）与原扫描判定逐项一致。
import { describe, expect, test } from 'vitest';

import {
  clonePlain,
  type Column,
  type Dialect,
  emptyModel,
  getDialect,
  type Kind,
  type Model,
  MutableModelIndex,
  type Obj,
  OverlayModelIndex,
  runMutator,
  withModelIndex,
} from '../src/index.ts';
import { nameEntriesOf } from '../src/naming-ns.ts';

const DIALECTS: readonly Dialect[] = ['pg', 'sqlite', 'mysql', 'mssql'];
const INT: Record<Dialect, string> = { pg: 'integer', sqlite: 'INTEGER', mysql: 'int', mssql: 'int' };
const KINDS: readonly Kind[] = [
  'schema',
  'table',
  'column',
  'primaryKey',
  'unique',
  'check',
  'foreignKey',
  'index',
  'sequence',
  'opaque',
];

const opaque = (id: string, parent: string, name: string, objType: 'view' | 'trigger' = 'view'): Obj =>
  ({
    id,
    kind: 'opaque',
    objType,
    parent,
    name,
    ddl: ['x'],
    drop: 'x',
    deps: [],
    order: 0,
    comment: null,
  }) as Obj;

const build = (dialect: Dialect): Model => {
  const m = emptyModel(dialect);
  const run = (name: string, args: unknown) => runMutator(m, name, args);
  run('createSchema', { id: 's0', name: getDialect(dialect).capabilities.defaultSchema });
  const s1 = dialect === 'mssql' || dialect === 'pg' ? 's1' : 's0';
  if (s1 === 's1') run('createSchema', { id: 's1', name: 'sales' });
  run('createTable', { id: 't', schema: 's0', name: 'Things' });
  run('addColumn', { table: 't', column: { id: 'ta', name: 'a', type: INT[dialect], notNull: true } });
  run('addColumn', {
    table: 't',
    column: {
      id: 'tb',
      name: 'b',
      type: INT[dialect],
      ...(dialect === 'mssql' ? { default: { expr: '((0))' } } : {}),
    },
  });
  run('addPrimaryKey', { id: 'tp', table: 't', columns: ['ta'] });
  run('addUnique', { id: 'tu', table: 't', columns: ['tb'] });
  run('addCheck', { id: 'tc', table: 't', expr: 'a > 0' });
  run('addIndex', { id: 'ti', table: 't', elements: [{ column: 'tb' }] });
  run('createTable', { id: 'u', schema: s1, name: 'Users' });
  run('addColumn', { table: 'u', column: { id: 'ua', name: 'a', type: INT[dialect], notNull: true } });
  run('addColumn', { table: 'u', column: { id: 'ub', name: 'b', type: INT[dialect] } });
  run('addForeignKey', { id: 'uf', table: 'u', columns: ['ub'], refTable: 't', refColumns: ['ta'] });
  run('addIndex', { id: 'ui', table: 'u', elements: [{ column: 'ua' }] });
  if (dialect === 'pg' || dialect === 'mssql') {
    run('createSequence', { id: 'q', schema: 's0', name: 'things_seq' });
  }
  if (dialect === 'pg') {
    run('setSequenceOwnedBy', { id: 'q', column: 'ta' });
    run('createTable', { id: 'p', schema: 's0', name: 'parts' });
    run('addColumn', { table: 'p', column: { id: 'pk', name: 'k', type: 'integer', notNull: true } });
    run('setPartitionBy', {
      id: 'p',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: 'pk', expr: null, opclass: null, collation: null }],
      },
    });
    run('createPartition', { id: 'p1', parent: 'p', name: 'parts_1', bound: 'FOR VALUES FROM (0) TO (10)' });
  }
  m.objects.v = opaque('v', 's0', 'V_Things');
  m.objects.tr = opaque('tr', 't', 'TR_Things', 'trigger');
  return m;
};

interface Harness {
  m: Model;
  draft: Model;
  tracked: OverlayModelIndex;
  untracked: OverlayModelIndex;
  note: (id: string) => void;
  touch: (id: string, f: (o: Obj) => void) => void;
  add: (o: Obj) => void;
  del: (id: string) => void;
}

/** 草稿 = 基线对象 + 叠加层克隆（直接改克隆再通知，模拟同步层 execute 的写时复制代理） */
const harness = (m: Model): Harness => {
  const base = new MutableModelIndex(m);
  const overlay = new Map<string, Obj | undefined>();
  const draft: Model = { ...m, objects: { ...m.objects } };
  const tracked = new OverlayModelIndex(base, overlay, draft);
  const note = tracked.trackWrites();
  const untracked = new OverlayModelIndex(base, overlay, draft);
  return {
    m,
    draft,
    tracked,
    untracked,
    note,
    touch: (id, f) => {
      const o = overlay.has(id) ? overlay.get(id)! : clonePlain(m.objects[id]!);
      overlay.set(id, o);
      draft.objects[id] = o;
      f(o);
      note(id);
    },
    add: (o) => {
      overlay.set(o.id, o);
      draft.objects[o.id] = o;
      note(o.id);
    },
    del: (id) => {
      overlay.set(id, undefined);
      delete draft.objects[id];
      note(id);
    },
  };
};

const ids = (xs: readonly Obj[]) => xs.map((o) => o.id);
const sortedIds = (xs: readonly Obj[]) => ids(xs).sort();
const cmpCols = (a: Column, b: Column) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1);

const expectSameStructure = (h: Harness) => {
  const objs = Object.values(h.draft.objects);
  const parents = new Set<string>(['ghost', ...Object.keys(h.m.objects), ...Object.keys(h.draft.objects)]);
  const { tracked: tr, untracked: un } = h;
  for (const kind of KINDS) {
    const want = objs.filter((o) => o.kind === kind);
    expect(ids(tr.allRef(kind)), `allRef ${kind}`).toEqual(ids(un.allRef(kind)));
    expect(sortedIds(tr.all(kind)), `all ${kind}`).toEqual(sortedIds(want));
  }
  for (const p of parents) {
    const kids = objs.filter((o) => 'parent' in o && o.parent === p);
    expect(ids(tr.allChildrenOf(p)), `allChildrenOf ${p}`).toEqual(ids(un.allChildrenOf(p)));
    expect(sortedIds(tr.allChildrenOf(p))).toEqual(sortedIds(kids));
    for (const kind of KINDS) {
      expect(ids(tr.childrenRef(p, kind)), `childrenRef ${p} ${kind}`).toEqual(ids(un.childrenRef(p, kind)));
      expect(sortedIds(tr.childrenOf(p, kind))).toEqual(sortedIds(kids.filter((o) => o.kind === kind)));
    }
    const cols = (kids.filter((o) => o.kind === 'column') as Column[]).sort(cmpCols);
    expect(ids(tr.columnsOf(p)), `columnsOf ${p}`).toEqual(ids(cols));
    expect(ids(tr.columnsRef(p))).toEqual(ids(cols));
    expect(ids(tr.partitionsRef(p)), `partitionsRef ${p}`).toEqual(ids(un.partitionsRef(p)));
    expect(sortedIds(tr.partitionsOf(p))).toEqual(
      sortedIds(objs.filter((o) => o.kind === 'table' && o.partitionOf?.parent === p)),
    );
    expect(sortedIds(tr.partitionDescendants(p))).toEqual(sortedIds(un.partitionDescendants(p)));
    expect(ids(tr.sequencesOwnedBy(p))).toEqual(ids(un.sequencesOwnedBy(p)));
    expect(sortedIds(tr.sequencesOwnedBy(p))).toEqual(
      sortedIds(objs.filter((o) => o.kind === 'sequence' && o.ownedBy === p)),
    );
  }
};

/** 名字判重：扫描（无索引）、全新基线索引、跟踪中的叠加索引、未跟踪的叠加索引（退回扫描）四条路径一致 */
const expectSameNameTaken = (h: Harness) => {
  const d = getDialect(h.draft.dialect);
  const draft = h.draft;
  const fresh = new MutableModelIndex(draft);
  // 预先保留旧的推导默认名，确保列改为显式 defaultName 后旧名字不再被占用；
  // SQLite / MySQL / MSSQL 的 nameEntriesOf 只会产生 `#df`（MSSQL 列默认值），不会产生 PG 专有的 `#nn` / `#seq`，
  // 额外加入 `<列>#nn` / `<列>#seq` 验证三方言将其视为普通（不匹配）ID。
  const names = new Set<string>(['', 'PRIMARY', 'primary', 'nope', 'DF_Things_b', 'DF_Renamed_b', 'DF_w_a']);
  const tableOf = (id: string) => {
    const t = draft.objects[id];
    return t?.kind === 'table' ? t : undefined;
  };
  const selves = new Set<string>(['', 'ghost', 'ta#nn', 'tb#nn', 'ta#seq', 'tb#seq']);
  for (const o of Object.values(draft.objects)) {
    if ('name' in o) {
      names.add(o.name);
      names.add(o.name.toUpperCase());
    }
    if (o.kind === 'column' && o.ext?.mssql?.defaultName) {
      names.add(o.ext.mssql.defaultName);
    }
    const es: { ns: string; name: string; owner: string }[] = [];
    nameEntriesOf(draft.dialect, o, tableOf, es);
    for (const e of es) {
      names.add(e.name);
      names.add(e.name.toUpperCase());
      selves.add(e.owner);
    }
    selves.add(o.id);
  }
  const containers = Object.values(draft.objects)
    .filter((o) => o.kind === 'schema' || o.kind === 'table')
    .map((o) => o.id);
  containers.push('ghost', 'tr');
  for (const space of ['rel', 'con', 'type'] as const) {
    if (space === 'type' && draft.dialect !== 'pg') continue;
    for (const c of containers) {
      for (const n of names) {
        for (const self of selves) {
          const label = `${space} ${c} ${n} ${self}`;
          let want: boolean | string;
          try {
            want = d.isNameTaken(draft, space, c, n, self);
          } catch (e) {
            // 扫描判定遇到不存在的容器会抛错（取所属表）；快路径不要求与之一致，跳过
            want = String(e);
          }
          if (typeof want === 'string') continue;
          expect(
            withModelIndex(draft, () => d.isNameTaken(draft, space, c, n, self), fresh),
            label,
          ).toBe(want);
          expect(
            withModelIndex(draft, () => d.isNameTaken(draft, space, c, n, self), h.tracked),
            label,
          ).toBe(want);
          expect(
            withModelIndex(draft, () => d.isNameTaken(draft, space, c, n, self), h.untracked),
            label,
          ).toBe(want);
        }
      }
    }
  }
};

const steps = (h: Harness, dialect: Dialect): (() => void)[] => [
  () => {},
  // 改表名（MSSQL 推导 DEFAULT 名随之变化）、改约束名（大小写混排）
  () => {
    h.touch('t', (o) => {
      if (o.kind === 'table') o.name = 'Renamed';
    });
    h.touch('tu', (o) => {
      if (o.kind === 'unique') o.name = 'V_THINGS';
    });
  },
  // 只通知不写入：未进叠加层的 ID 不得遮蔽基线对象
  () => {
    h.note('ua');
    h.note('ghost');
  },
  // 新增约束 / 索引，与既有名字大小写不同地撞名
  () => {
    h.add({
      id: 'uc',
      kind: 'check',
      parent: 'u',
      name: 'TC_NEW',
      nameMode: 'explicit',
      expr: 'a > 1',
      noInherit: false,
      comment: null,
    } as Obj);
    h.add({
      id: 'ux',
      kind: 'index',
      parent: 'u',
      name: 'things_B_IDX',
      nameMode: 'explicit',
      unique: false,
      method: 'btree',
      elements: [{ column: 'ub', expr: null, desc: false, nullsFirst: null, opclass: null, collation: null }],
      include: [],
      where: null,
      nullsNotDistinct: false,
      comment: null,
    } as Obj);
  },
  // 表换 schema（PG / MSSQL 子对象条目整体迁移）
  () => {
    h.touch('u', (o) => {
      if (o.kind === 'table') o.parent = 's0';
    });
  },
  // 删除基线对象；列原地换表
  () => {
    h.del('ti');
    h.del('tc');
    h.touch('ub', (o) => {
      if (o.kind === 'column') o.parent = 't';
    });
  },
  // 新建表再删掉它的主键（叠加层先建后删），新表成为子分区；序列换归属列
  () => {
    h.add({
      id: 'w',
      kind: 'table',
      parent: 's0',
      name: 'w',
      partitionBy: null,
      partitionOf: null,
      comment: null,
    } as Obj);
    h.add({
      id: 'wa',
      kind: 'column',
      parent: 'w',
      name: 'a',
      pos: 'a0',
      type: INT[dialect],
      typeRef: null,
      notNull: true,
      notNullName: null,
      notNullNameMode: 'derived',
      default: dialect === 'mssql' ? { expr: '((1))' } : null,
      identity: null,
      generated: null,
      collation: null,
      comment: null,
    } as Obj);
    h.add({
      id: 'wp',
      kind: 'primaryKey',
      parent: 'w',
      name: 'W_PK',
      nameMode: 'explicit',
      columns: ['wa'],
      comment: null,
    } as Obj);
    h.del('wp');
    if (dialect === 'pg') {
      h.touch('w', (o) => {
        if (o.kind === 'table') o.partitionOf = { parent: 'p', bound: 'FOR VALUES FROM (0) TO (1)' };
      });
      h.touch('q', (o) => {
        if (o.kind === 'sequence') o.ownedBy = 'wa';
      });
    }
  },
  // 原地改基线列（经叠加层克隆），再把新建的子分区移回普通表
  () => {
    h.touch('ta', (o) => {
      if (o.kind === 'column') o.pos = 'zz';
    });
    if (dialect === 'pg') {
      h.touch('w', (o) => {
        if (o.kind === 'table') o.partitionOf = null;
      });
    }
    h.del('v');
  },
  // MSSQL 列设显式 ext.mssql.defaultName（含大小写变体），覆盖 defaultName ?? 推导名 分支
  () => {
    if (dialect !== 'mssql') return;
    h.touch('tb', (o) => {
      if (o.kind === 'column') {
        o.ext = {
          ...o.ext,
          mssql: { ...o.ext?.mssql, defaultName: 'DF_Custom_MixCase', defaultNameMode: 'explicit' },
        };
      }
    });
    h.touch('wa', (o) => {
      if (o.kind === 'column') {
        o.ext = {
          ...o.ext,
          mssql: { ...o.ext?.mssql, defaultName: 'df_WA_Explicit', defaultNameMode: 'explicit' },
        };
      }
    });
  },
];

describe('OverlayModelIndex 叠加层分桶：增量维护与从头折叠、直接过滤一致', () => {
  for (const dialect of DIALECTS) {
    test(dialect, () => {
      const h = harness(build(dialect));
      for (const step of steps(h, dialect)) {
        step();
        expectSameStructure(h);
      }
    });
  }
});

describe('isNameTaken 命名空间快路径：与扫描判定逐项一致', () => {
  for (const dialect of ['sqlite', 'mysql', 'mssql'] as const) {
    test(dialect, () => {
      const h = harness(build(dialect));
      for (const step of steps(h, dialect)) {
        step();
        expectSameNameTaken(h);
      }
      h.tracked.finishTracking();
    });
  }
});
