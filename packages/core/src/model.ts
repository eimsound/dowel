// 在扁平模型上查询对象的工具函数，以及模型的一致性校验。
import { EditError } from './errors.ts';
import type { Column, Enum, Index, Kind, Model, Obj, ObjOf, Sequence, Table } from './ir.ts';
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
    for (const c of cols) {
      const col = m.objects[c];
      if (col?.kind !== 'column' || col.parent !== table)
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
      case 'table':
        need(o, o.parent, 'schema', 'parent');
        need(o, o.partitionOf?.parent, 'table', 'partitionOf');
        if (typeof o.partitionBy === 'string') {
          if (o.partitionBy.trim() === '') errs.push(`table ${o.name}：partitionBy 不能为空字符串`);
        } else if (o.partitionBy !== null) {
          for (const k of o.partitionBy.keys) {
            if (!!k.column === !!k.expr) errs.push(`table ${o.name}：分区键必须且只能指定列或表达式之一`);
            if (k.column) colOfTable(o, o.id, [k.column], 'partitionBy');
          }
        }
        claim(`rel:${o.parent}`, o.name, o);
        claim(`type:${o.parent}`, o.name, o); // 表自带同名的行类型
        break;
      case 'column': {
        need(o, o.parent, 'table', 'parent');
        need(o, o.typeRef, 'enum', 'typeRef');
        claim(`col:${o.parent}`, o.name, o);
        if (o.default && 'nextval' in o.default) need(o, o.default.nextval, 'sequence', 'default');
        if (o.notNull && o.notNullName) claim(`con:${o.parent}`, o.notNullName, o);
        if (o.identity) {
          if (o.default) errs.push(`列 ${o.name}：identity 列不能有默认值`);
          if (!o.notNull) errs.push(`列 ${o.name}：identity 列必须 NOT NULL`);
          const t = m.objects[o.parent];
          if (t?.kind === 'table') claim(`rel:${t.parent}`, o.identity.sequenceName, o);
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
    if (childrenOf(m, t.id, 'primaryKey').length > 1) errs.push(`表 ${t.name}：主键不止一个`);
  }
  return errs;
};
