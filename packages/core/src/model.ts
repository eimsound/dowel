// 在扁平模型上查询对象的工具函数，以及模型的一致性校验。
import { EditError } from './errors.ts';
import type { Column, Enum, Index, Kind, Model, Obj, ObjOf, PartitionSpec, Sequence, Table } from './ir.ts';
import { buildModelIndex, type ModelIndex } from './model-index.ts';
import { resolvePartitionBy } from './pg/partition.ts';
import { ident } from './pg/quote.ts';
import { getDialect } from './registry.ts';

export { buildModelIndex, type ModelIndex, MutableModelIndex, OverlayModelIndex } from './model-index.ts';

/**
 * 仅在受控只读/作用域事务内有效的索引栈（进入前压栈，finally 必弹栈）。
 * 绝不把索引长期挂在可变 Model 上，保证外部直接修改 m.objects 时永远读取实时数据。
 */
const scopedIndexes = new WeakMap<Model, ModelIndex[]>();

export const getActiveModelIndex = (m: Model): ModelIndex | undefined => {
  const stack = scopedIndexes.get(m);
  return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
};

export const withModelIndex = <T>(m: Model, fn: (idx: ModelIndex) => T, existing?: ModelIndex): T => {
  const idx = existing ?? buildModelIndex(m);
  let stack = scopedIndexes.get(m);
  if (!stack) {
    stack = [];
    scopedIndexes.set(m, stack);
  }
  stack.push(idx);
  try {
    return fn(idx);
  } finally {
    stack.pop();
    if (stack.length === 0) scopedIndexes.delete(m);
  }
};

export const get = <K extends Kind>(m: Model, id: string, kind?: K): ObjOf<K> => {
  const o = m.objects[id];
  if (!o) throw new EditError(`对象不存在：${id}`);
  if (kind && o.kind !== kind) throw new EditError(`对象 ${id} 是 ${o.kind}，不是 ${kind}`);
  return o as ObjOf<K>;
};

export const find = (m: Model, id: string | null | undefined): Obj | undefined =>
  id ? m.objects[id] : undefined;

export const all = <K extends Kind>(m: Model, kind: K): ObjOf<K>[] => {
  const idx = getActiveModelIndex(m);
  if (idx) return idx.all(kind);
  return Object.values(m.objects).filter((o): o is ObjOf<K> => o.kind === kind);
};

export const childrenOf = <K extends Kind>(m: Model, parent: string, kind: K): ObjOf<K>[] => {
  const idx = getActiveModelIndex(m);
  if (idx) return idx.childrenOf(parent, kind);
  return Object.values(m.objects).filter(
    (o): o is ObjOf<K> => o.kind === kind && 'parent' in o && o.parent === parent,
  );
};

/**
 * 指定几种 kind 的全部对象：有活动索引时直接取索引里的分桶（不经过写时复制代理逐个枚举整个模型），
 * 否则退回单趟扫描。用于方言的重名判定等热点路径，语义与过滤 Object.values(m.objects) 完全一致。
 */
export const objectsOfKinds = (m: Model, kinds: readonly Kind[]): readonly Obj[] => {
  const idx = getActiveModelIndex(m);
  if (idx) return kinds.length === 1 ? idx.allRef(kinds[0]!) : kinds.flatMap((k) => idx.allRef(k));
  const want = new Set<string>(kinds);
  return Object.values(m.objects).filter((o) => want.has(o.kind));
};

/** 某父对象下指定几种 kind 的直接子对象（有活动索引时走索引） */
export const childrenOfKinds = (m: Model, parent: string, kinds: readonly Kind[]): readonly Obj[] => {
  const idx = getActiveModelIndex(m);
  if (idx) return kinds.flatMap((k) => idx.childrenRef(parent, k));
  const want = new Set<string>(kinds);
  return Object.values(m.objects).filter((o) => want.has(o.kind) && 'parent' in o && o.parent === parent);
};

/** 某父对象下的全部直接子对象（不限 kind） */
export const allChildrenOf = (m: Model, parent: string): Obj[] => {
  const idx = getActiveModelIndex(m);
  if (idx) return idx.allChildrenOf(parent);
  return Object.values(m.objects).filter((o) => 'parent' in o && o.parent === parent);
};

/** 按展示顺序排列的列 */
export const columnsOf = (m: Model, table: string): Column[] => {
  const idx = getActiveModelIndex(m);
  if (idx) return idx.columnsOf(table);
  return childrenOf(m, table, 'column').sort((a, b) =>
    a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1,
  );
};

export const colName = (m: Model, id: string): string => get(m, id, 'column').name;

export const schemaName = (m: Model, o: Table | Enum | Sequence): string => get(m, o.parent, 'schema').name;

/** 带 schema 的引用名：表、枚举、序列 */
export const qname = (m: Model, o: Table | Enum | Sequence): string =>
  getDialect(m.dialect).quoteQualified(schemaName(m, o), o.name);

export const tableOfColumn = (m: Model, col: string): Table => get(m, get(m, col, 'column').parent, 'table');

export const isPartitionParent = (table: Pick<Table, 'partitionBy'>): boolean => table.partitionBy !== null;

export const isPartitionChild = (table: Pick<Table, 'partitionOf'>): boolean => table.partitionOf !== null;

/** 沿 partitionOf 链向上查找根分区父表（非子分区返回自身；带环保护） */
export const rootTableId = (m: Model, tableId: string): string => {
  const seen = new Set<string>();
  let cur = tableId;
  while (!seen.has(cur)) {
    seen.add(cur);
    const t = m.objects[cur];
    if (t?.kind !== 'table' || !t.partitionOf) return cur;
    if (!(t.partitionOf.parent in m.objects)) return cur;
    cur = t.partitionOf.parent;
  }
  return cur;
};

/** 某分区父表下的全部直接子分区 */
export const partitionsOf = (m: Model, parentId: string): Table[] => {
  const idx = getActiveModelIndex(m);
  if (idx) return idx.partitionsOf(parentId);
  return all(m, 'table').filter((t) => t.partitionOf?.parent === parentId);
};

/** 某分区父表下的全部后代子分区（按广度优先顺序，浅层在前；带环保护） */
export const partitionDescendants = (m: Model, parentId: string): Table[] => {
  const idx = getActiveModelIndex(m);
  if (idx) return idx.partitionDescendants(parentId);
  const out: Table[] = [];
  const seen = new Set<string>([parentId]);
  const queue = [parentId];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const child of partitionsOf(m, pid)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
};

/** 某分区子表的全部严格祖先分区表（按由近及远顺序，不含自身；带环保护） */
export const partitionAncestors = (m: Model, tableId: string): Table[] => {
  const out: Table[] = [];
  const seen = new Set<string>([tableId]);
  const self = m.objects[tableId];
  let cur = self?.kind === 'table' && self.partitionOf ? self.partitionOf.parent : null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const t = m.objects[cur];
    if (t?.kind !== 'table') break;
    out.push(t);
    cur = t.partitionOf?.parent ?? null;
  }
  return out;
};

/** 表的分区深度：普通表和根分区父表为 0，一级子分区为 1，二级子分区为 2，以此类推 */
export const partitionDepth = (m: Model, tableId: string): number => {
  const seen = new Set<string>();
  let cur = tableId;
  let depth = 0;
  while (!seen.has(cur)) {
    seen.add(cur);
    const t = m.objects[cur];
    if (t?.kind !== 'table' || !t.partitionOf) return depth;
    if (!(t.partitionOf.parent in m.objects)) return depth;
    cur = t.partitionOf.parent;
    depth++;
  }
  return depth;
};

/** 表的有效列（子分区沿 partitionOf 链继承根父表的列） */
export const effectiveColumnsOf = (m: Model, tableId: string): Column[] =>
  columnsOf(m, rootTableId(m, tableId));

/**
 * 汇总分区表及其全部后代分区表对主键/唯一约束/唯一索引的分区键要求（支持多级分区）：
 * PG 要求父表的唯一约束或唯一索引必须包含本表及所有下级子分区的全部分区键列，
 * 且任一层包含表达式分区键时，上级表不得创建主键/唯一约束/唯一索引。
 */
export const requiredUniquePartitionKeys = (
  m: Model,
  tableId: string,
  override?: { tableId: string; spec: PartitionSpec | null },
): { directCols: string[]; hasExprKey: boolean } => {
  const t = find(m, tableId);
  if (t?.kind !== 'table') return { directCols: [], hasExprKey: false };
  const directCols: string[] = [];
  let hasExprKey = false;
  for (const tb of [t, ...partitionDescendants(m, tableId)]) {
    const spec = override && tb.id === override.tableId ? override.spec : resolvePartitionBy(m, tb);
    if (!spec) continue;
    for (const k of spec.keys) {
      if (k.expr !== null) {
        hasExprKey = true;
      } else if (k.column && !directCols.includes(k.column)) {
        directCols.push(k.column);
      }
    }
  }
  return { directCols, hasExprKey };
};

/** 将表的 partitionBy 渲染为 PG `PARTITION BY` 之后的分句（兼容存量原始字符串与结构化 PartitionSpec） */
export const partitionBySql = (
  m: Model,
  table: Pick<Table, 'partitionBy'>,
  fallbackModel?: Model,
): string | null => {
  const p = table.partitionBy;
  if (!p) return null;
  if (typeof p === 'string') return p;
  const keys = p.keys
    .map((k) => {
      if (!!k.column === !!k.expr) throw new EditError('分区键必须且只能指定列或表达式之一');
      let s: string;
      if (k.column) {
        const col = find(m, k.column) ?? (fallbackModel ? find(fallbackModel, k.column) : undefined);
        if (col?.kind !== 'column') throw new EditError(`找不到对象：${k.column}`);
        s = ident(col.name);
      } else {
        s = `(${k.expr})`;
      }
      if (k.collation) s += ` COLLATE ${k.collation}`;
      if (k.opclass) s += ` ${k.opclass}`;
      return s;
    })
    .join(', ');
  return `${p.strategy.toUpperCase()} (${keys})`;
};

export const formatPartitionBy = partitionBySql;

/** 索引元素在自动命名中使用的名字：列取列名，表达式取最外层函数名，否则为 expr；重复时加数字 */
export const indexElementNames = (m: Model, idx: Pick<Index, 'elements' | 'include'>): string[] => {
  const raw = [
    ...idx.elements.map((e) => {
      if (e.column) return colName(m, e.column);
      const fn = /^\s*(?:[a-z_][a-z0-9_$]*\.)?([a-z_][a-z0-9_$]*)\s*\(/i.exec(e.expr ?? '');
      return fn ? fn[1]!.toLowerCase() : 'expr';
    }),
    ...idx.include.map((c) => colName(m, c)),
  ];
  const out: string[] = [];
  for (const n of raw) {
    let cur = n;
    for (let i = 1; out.includes(cur); i++) cur = `${n}${i}`;
    out.push(cur);
  }
  return out;
};

/** 模型的一致性校验：通用引用一致性 + 方言专属命名空间/长度/能力校验。返回错误列表（空表示通过）。 */
export const validate = (m: Model): string[] =>
  withModelIndex(m, (idx) => {
    const errs: string[] = [];
    const need = (o: Obj, ref: string | null | undefined, kind: Kind, what: string) => {
      if (!ref) return;
      const t = m.objects[ref];
      if (!t || t.kind !== kind) errs.push(`${o.kind} ${o.name}：${what} 指向不存在的 ${kind} ${ref}`);
    };
    const colOfTable = (o: Obj, table: string, cols: string[], what: string) => {
      const root = rootTableId(m, table);
      for (const c of cols) {
        const col = m.objects[c];
        if (col?.kind !== 'column' || (col.parent !== table && col.parent !== root))
          errs.push(`${o.kind} ${o.name}：${what} 引用的列 ${c} 不在表 ${table} 中`);
      }
    };

    for (const [k, o] of Object.entries(m.objects)) {
      if (o.id !== k) errs.push(`对象 ${o.id} 的键与 id 不一致`);
      switch (o.kind) {
        case 'schema':
          break;
        case 'extension':
          need(o, o.parent, 'schema', 'parent');
          break;
        case 'opaque': {
          const p = m.objects[o.parent];
          if (!p || (p.kind !== 'schema' && p.kind !== 'table'))
            errs.push(`${o.objType} ${o.name}：parent 不存在`);
          for (const d of o.deps)
            if (!m.objects[d]) errs.push(`${o.objType} ${o.name}：依赖的对象 ${d} 不存在`);
          break;
        }
        case 'enum':
          need(o, o.parent, 'schema', 'parent');
          if (new Set(o.values).size !== o.values.length) errs.push(`enum ${o.name}：值重复`);
          break;
        case 'sequence':
          need(o, o.parent, 'schema', 'parent');
          need(o, o.ownedBy, 'column', 'ownedBy');
          break;
        case 'table':
          need(o, o.parent, 'schema', 'parent');
          need(o, o.partitionOf?.parent, 'table', 'partitionOf');
          break;
        case 'column':
          need(o, o.parent, 'table', 'parent');
          need(o, o.typeRef, 'enum', 'typeRef');
          if (o.default && 'nextval' in o.default) need(o, o.default.nextval, 'sequence', 'default');
          if (o.identity) {
            if (o.default) errs.push(`列 ${o.name}：identity 列不能有默认值`);
            if (!o.notNull) errs.push(`列 ${o.name}：identity 列必须 NOT NULL`);
          }
          if (o.generated && (o.default || o.identity))
            errs.push(`列 ${o.name}：生成列不能有默认值或 identity`);
          break;
        case 'primaryKey':
        case 'unique':
        case 'foreignKey':
        case 'check':
        case 'index': {
          need(o, o.parent, 'table', 'parent');
          if (o.kind !== 'check') {
            const cols =
              o.kind === 'index'
                ? [...o.elements.flatMap((e) => (e.column ? [e.column] : [])), ...o.include]
                : o.columns;
            colOfTable(o, o.parent, cols, 'columns');
          }
          if (o.kind === 'foreignKey') {
            need(o, o.refTable, 'table', 'refTable');
            colOfTable(o, o.refTable, o.refColumns, 'refColumns');
            if (o.columns.length !== o.refColumns.length) errs.push(`外键 ${o.name}：两边列数不同`);
          }
          if (o.kind === 'index') {
            for (const e of o.elements)
              if (!!e.column === !!e.expr) errs.push(`索引 ${o.name}：元素必须是列或表达式之一`);
          }
          if (o.kind === 'primaryKey') {
            for (const c of o.columns) {
              const col = m.objects[c];
              if (col?.kind === 'column' && !col.notNull)
                errs.push(`主键 ${o.name}：列 ${col.name} 必须 NOT NULL`);
            }
          }
          break;
        }
      }
    }
    for (const t of idx.allRef('table')) {
      const pks = idx.childrenRef(t.id, 'primaryKey');
      if (pks.length > 1) errs.push(`表 ${t.name}：主键不止一个`);
    }
    errs.push(...getDialect(m.dialect).validateModel(m));
    return errs;
  });
