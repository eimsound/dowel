// 在扁平模型上查询对象的工具函数，以及模型的一致性校验。
import { EditError } from './errors.ts';
import type { Column, Enum, Index, Kind, Model, Obj, ObjOf, PartitionSpec, Sequence, Table } from './ir.ts';
import { parsePartitionBound, resolvePartitionBy, validatePartitionBound } from './pg/partition.ts';
import { ident, qualified } from './pg/quote.ts';

export const get = <K extends Kind>(m: Model, id: string, kind?: K): ObjOf<K> => {
  const o = m.objects[id];
  if (!o) throw new EditError(`对象不存在：${id}`);
  if (kind && o.kind !== kind) throw new EditError(`对象 ${id} 是 ${o.kind}，不是 ${kind}`);
  return o as ObjOf<K>;
};

export const find = (m: Model, id: string | null | undefined): Obj | undefined =>
  id ? m.objects[id] : undefined;

export const all = <K extends Kind>(m: Model, kind: K): ObjOf<K>[] =>
  Object.values(m.objects).filter((o): o is ObjOf<K> => o.kind === kind);

export const childrenOf = <K extends Kind>(m: Model, parent: string, kind: K): ObjOf<K>[] =>
  all(m, kind).filter((o) => 'parent' in o && o.parent === parent);

/** 按展示顺序排列的列 */
export const columnsOf = (m: Model, table: string): Column[] =>
  childrenOf(m, table, 'column').sort((a, b) =>
    a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1,
  );

export const colName = (m: Model, id: string): string => get(m, id, 'column').name;

export const schemaName = (m: Model, o: Table | Enum | Sequence): string => get(m, o.parent, 'schema').name;

/** 带 schema 的引用名：表、枚举、序列 */
export const qname = (m: Model, o: Table | Enum | Sequence): string => qualified(schemaName(m, o), o.name);

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
export const partitionsOf = (m: Model, parentId: string): Table[] =>
  all(m, 'table').filter((t) => t.partitionOf?.parent === parentId);

/** 某分区父表下的全部后代子分区（按广度优先顺序，浅层在前；带环保护） */
export const partitionDescendants = (m: Model, parentId: string): Table[] => {
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

/** 模型的一致性校验：引用都存在、同一命名空间内不重名。返回错误列表（空表示通过）。 */
export const validate = (m: Model): string[] => {
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
  const ns = new Map<string, string>();
  const claim = (space: string, name: string, o: Obj) => {
    const k = `${space}\u0000${name}`;
    const prev = ns.get(k);
    if (prev && prev !== o.id) errs.push(`名字冲突：${name}（${space}）`);
    ns.set(k, o.id);
  };

  for (const o of Object.values(m.objects)) {
    if (o.id !== Object.keys(m.objects).find((k) => m.objects[k] === o))
      errs.push(`对象 ${o.id} 的键与 id 不一致`);
    switch (o.kind) {
      case 'schema':
        claim('schema', o.name, o);
        break;
      case 'extension':
        need(o, o.parent, 'schema', 'parent');
        claim('extension', o.name, o);
        break;
      case 'opaque': {
        const p = m.objects[o.parent];
        if (!p || (p.kind !== 'schema' && p.kind !== 'table'))
          errs.push(`${o.objType} ${o.name}：parent 不存在`);
        for (const d of o.deps)
          if (!m.objects[d]) errs.push(`${o.objType} ${o.name}：依赖的对象 ${d} 不存在`);
        claim(`opaque:${o.objType}:${o.parent}`, o.name, o);
        break;
      }
      case 'enum':
        need(o, o.parent, 'schema', 'parent');
        claim(`type:${o.parent}`, o.name, o);
        if (new Set(o.values).size !== o.values.length) errs.push(`enum ${o.name}：值重复`);
        break;
      case 'sequence':
        need(o, o.parent, 'schema', 'parent');
        need(o, o.ownedBy, 'column', 'ownedBy');
        claim(`rel:${o.parent}`, o.name, o);
        break;
      case 'table': {
        need(o, o.parent, 'schema', 'parent');
        need(o, o.partitionOf?.parent, 'table', 'partitionOf');
        if (o.partitionOf) {
          const parentTable = m.objects[o.partitionOf.parent];
          if (parentTable?.kind === 'table') {
            if (parentTable.partitionBy === null)
              errs.push(`table ${o.name}：partitionOf 指向的表 ${parentTable.name} 不是分区父表`);
            // 环引用检测
            const seen = new Set<string>([o.id]);
            let cur: string | null = o.partitionOf.parent;
            while (cur) {
              if (seen.has(cur)) {
                errs.push(`table ${o.name}：partitionOf 存在环引用`);
                break;
              }
              seen.add(cur);
              const next: Obj | undefined = m.objects[cur];
              cur = next?.kind === 'table' && next.partitionOf ? next.partitionOf.parent : null;
            }
            if (parentTable.partitionBy && typeof parentTable.partitionBy !== 'string') {
              const boundErr = validatePartitionBound(
                parentTable.partitionBy.strategy,
                o.partitionOf.bound,
                parentTable.partitionBy.keys.length,
              );
              if (boundErr) errs.push(`table ${o.name}：${boundErr}`);
            } else if (!o.partitionOf.bound.trim()) {
              errs.push(`table ${o.name}：partitionOf.bound 不能为空`);
            }
          }
        }
        if (typeof o.partitionBy === 'string') {
          if (o.partitionBy.trim() === '') errs.push(`table ${o.name}：partitionBy 不能为空字符串`);
        } else if (o.partitionBy !== null) {
          if (o.partitionBy.keys.length === 0) errs.push(`table ${o.name}：partitionBy 至少需要一个分区键`);
          if (o.partitionBy.strategy === 'list' && o.partitionBy.keys.length !== 1)
            errs.push(`table ${o.name}：LIST 分区策略只能有 1 个分区键`);
          for (const k of o.partitionBy.keys) {
            if (!!k.column === !!k.expr) errs.push(`table ${o.name}：分区键必须且只能指定列或表达式之一`);
            if (k.column) {
              colOfTable(o, o.id, [k.column], 'partitionBy');
              const col = m.objects[k.column];
              if (col?.kind === 'column' && col.generated)
                errs.push(`table ${o.name}：生成列 ${col.name} 不能作为分区键`);
            }
          }
        }
        claim(`rel:${o.parent}`, o.name, o);
        claim(`type:${o.parent}`, o.name, o); // 表自带同名的行类型
        break;
      }
      case 'column': {
        need(o, o.parent, 'table', 'parent');
        need(o, o.typeRef, 'enum', 'typeRef');
        const parentTable = m.objects[o.parent];
        if (parentTable?.kind === 'table' && parentTable.partitionOf !== null) {
          const root = m.objects[rootTableId(m, parentTable.id)];
          if (!(root?.kind === 'table' && typeof root.partitionBy === 'string')) {
            errs.push(`列 ${o.name}：分区子表 ${parentTable.name} 不能直接拥有列，列应定义在根分区父表上`);
          }
        }
        claim(`col:${o.parent}`, o.name, o);
        if (o.default && 'nextval' in o.default) need(o, o.default.nextval, 'sequence', 'default');
        if (o.notNull && o.notNullName) claim(`con:${o.parent}`, o.notNullName, o);
        if (o.identity) {
          if (o.default) errs.push(`列 ${o.name}：identity 列不能有默认值`);
          if (!o.notNull) errs.push(`列 ${o.name}：identity 列必须 NOT NULL`);
          if (parentTable?.kind === 'table') claim(`rel:${parentTable.parent}`, o.identity.sequenceName, o);
        }
        if (o.generated && (o.default || o.identity))
          errs.push(`列 ${o.name}：生成列不能有默认值或 identity`);
        break;
      }
      case 'primaryKey':
      case 'unique':
      case 'foreignKey':
      case 'check':
      case 'index': {
        need(o, o.parent, 'table', 'parent');
        const t = m.objects[o.parent];
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
        if (t?.kind === 'table' && t.partitionBy !== null) {
          if (o.kind === 'check' && o.noInherit) {
            errs.push(`检查约束 ${o.name}：分区父表的 CHECK 约束不能设为 NO INHERIT`);
          }
          const req = requiredUniquePartitionKeys(m, t.id);
          if (o.kind === 'primaryKey' || o.kind === 'unique') {
            const label = o.kind === 'primaryKey' ? '主键' : '唯一约束';
            if (req.hasExprKey) {
              errs.push(`${label} ${o.name}：包含表达式分区键的分区表不能创建主键或唯一约束`);
            } else if (req.directCols.some((c) => !o.columns.includes(c))) {
              errs.push(`${label} ${o.name}：分区表的主键或唯一约束必须包含全部分区键列`);
            }
          } else if (o.kind === 'index' && o.unique) {
            if (req.hasExprKey) {
              errs.push(`唯一索引 ${o.name}：包含表达式分区键的分区表不支持唯一索引`);
            } else if (req.directCols.some((c) => !o.elements.some((e) => e.column === c))) {
              errs.push(`唯一索引 ${o.name}：分区表的唯一索引必须包含全部分区键`);
            }
          }
        }
        // 主键、唯一约束和索引的名字同时占用关系命名空间（它们背后是索引）
        if (o.kind !== 'index') claim(`con:${o.parent}`, o.name, o);
        if ((o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'index') && t?.kind === 'table')
          claim(`rel:${t.parent}`, o.name, o);
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
  for (const t of all(m, 'table')) {
    const pks = childrenOf(m, t.id, 'primaryKey');
    if (pks.length > 1) errs.push(`表 ${t.name}：主键不止一个`);
    if (t.partitionBy !== null) {
      if (pks.length > 0) {
        for (const desc of partitionDescendants(m, t.id)) {
          if (childrenOf(m, desc.id, 'primaryKey').length > 0) {
            errs.push(`表 ${desc.name}：祖先分区表 ${t.name} 已有主键，子分区不能再定义主键`);
          }
        }
      }
      const defaults = partitionsOf(m, t.id).filter(
        (c) => parsePartitionBound(c.partitionOf!.bound)?.kind === 'default',
      );
      if (defaults.length > 1) errs.push(`表 ${t.name}：最多只能有 1 个 DEFAULT 子分区`);
    }
  }
  return errs;
};
