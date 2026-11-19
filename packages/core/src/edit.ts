// 编辑操作：在模型上做一次有语义的修改（直接修改传入的模型）。
// 这些操作就是同步层的 mutator（04-ir-design.md 第 2 节）：客户端乐观执行，服务器在最新状态上重新执行并校验。
import { generateKeyBetween } from 'fractional-indexing';
import { EditError } from './errors.ts';
import { newId } from './ids.ts';
import type {
  Check,
  Column,
  ColumnDefault,
  Enum,
  ForeignKey,
  Index,
  IndexElement,
  Model,
  Obj,
  PrimaryKey,
  Schema,
  Sequence,
  SequenceOptions,
  Table,
  Unique,
} from './ir.ts';
import { all, childrenOf, colName, columnsOf, find, get, indexElementNames } from './model.ts';
import { chooseName, joinNames } from './pg/naming.ts';
import { ident, KEYWORDS } from './pg/quote.ts';

export { EditError };

// ───── 表达式里的标识符 ─────

type Token = { text: string; kind: 'ident' | 'qident' | 'other'; start: number; end: number };

/** 简单的 PG 表达式词法分析：识别字符串、带引号标识符、普通标识符，其余字符原样保留 */
export const tokenize = (s: string): Token[] => {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    const start = i;
    if (ch === "'" || ((ch === 'E' || ch === 'e') && s[i + 1] === "'")) {
      if (ch !== "'") i++;
      i++;
      while (i < s.length) {
        if (s[i] === '\\' && ch !== "'") i += 2;
        else if (s[i] === "'" && s[i + 1] === "'") i += 2;
        else if (s[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
    } else if (ch === '$' && /^\$([A-Za-z_]\w*)?\$/.test(s.slice(i))) {
      const tag = /^\$([A-Za-z_]\w*)?\$/.exec(s.slice(i))![0];
      const close = s.indexOf(tag, i + tag.length);
      i = close < 0 ? s.length : close + tag.length;
      out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
    } else if (ch === '"') {
      i++;
      while (i < s.length) {
        if (s[i] === '"' && s[i + 1] === '"') i += 2;
        else if (s[i] === '"') {
          i++;
          break;
        } else i++;
      }
      out.push({ text: s.slice(start + 1, i - 1).replaceAll('""', '"'), kind: 'qident', start, end: i });
    } else if (/[A-Za-z_\u0080-￿]/.test(ch)) {
      while (i < s.length && /[A-Za-z0-9_$\u0080-￿]/.test(s[i]!)) i++;
      out.push({ text: s.slice(start, i).toLowerCase(), kind: 'ident', start, end: i });
    } else {
      i++;
      out.push({ text: ch, kind: 'other', start, end: i });
    }
  }
  return out;
};

/**
 * 表达式里作为列引用出现的名字。跳过：函数名（后面跟括号）、类型名（`::` 之后的整个限定名，如 `::public."user"`）、
 * 限定名中前面的部分（`t.col` 的 `t`）。
 */
const columnRefs = (expr: string): Token[] => {
  const sig = tokenize(expr).filter((x) => !/^\s$/.test(x.text));
  const out: Token[] = [];
  for (let i = 0; i < sig.length; i++) {
    const x = sig[i]!;
    if (x.text === ':' && sig[i + 1]?.text === ':') {
      // 跳过类型名：ident ( . ident )*
      i += 2;
      while (sig[i + 1]?.text === '.' && sig[i + 2] && sig[i + 2]!.kind !== 'other') i += 2;
      continue;
    }
    if (x.kind === 'other') continue;
    const next = sig[i + 1]?.text;
    if (next === '(' || next === '.') continue;
    out.push(x);
  }
  return out;
};

/**
 * 校验表达式里的列引用都是本表存在的列（关键字除外）。
 * 只能发现明显的错误（如列已被改名、删除）；完整的语义校验由影子库完成。
 */
export const checkExprColumns = (m: Model, table: string, expr: string) => {
  const names = new Set(columnsOf(m, table).map((c) => c.name));
  const unknown = columnRefs(expr)
    .filter((t) => !names.has(t.text) && !(t.kind === 'ident' && KEYWORDS.has(t.text)))
    .map((t) => t.text);
  if (unknown.length) throw new EditError(`表达式引用了不存在的列：${[...new Set(unknown)].join('、')}`);
};

export const exprReferences = (expr: string, name: string): boolean =>
  columnRefs(expr).some((x) => x.text === name);

/** 改写表达式里的限定名 `schema.name`（类型改名、schema 改名时用） */
export const renameQualifiedInExpr = (
  expr: string,
  schema: string,
  name: string | null,
  to: { schema: string; name: string | null },
): string => {
  const t = tokenize(expr);
  let out = expr;
  const match = (x: Token | undefined, n: string) =>
    !!x && ((x.kind === 'ident' && x.text === n) || (x.kind === 'qident' && x.text === n));
  for (let i = t.length - 1; i >= 0; i--) {
    if (!match(t[i], schema) || t[i + 1]?.text !== '.') continue;
    if (name === null) {
      out = out.slice(0, t[i]!.start) + ident(to.schema) + out.slice(t[i]!.end);
    } else if (match(t[i + 2], name)) {
      out = `${out.slice(0, t[i]!.start)}${ident(to.schema)}.${ident(to.name!)}${out.slice(t[i + 2]!.end)}`;
    }
  }
  return out;
};

/** 对模型里所有表达式应用同一个改写 */
export const rewriteExprs = (m: Model, f: (expr: string) => string) => {
  for (const o of Object.values(m.objects)) {
    if (o.kind === 'check') o.expr = f(o.expr);
    if (o.kind === 'index') {
      for (const e of o.elements) if (e.expr) e.expr = f(e.expr);
      if (o.where) o.where = f(o.where);
    }
    if (o.kind === 'column') {
      if (o.generated) o.generated.expr = f(o.generated.expr);
      if (o.default && 'expr' in o.default) o.default.expr = f(o.default.expr);
    }
  }
};

export const renameInExpr = (expr: string, from: string, to: string): string => {
  let out = expr;
  for (const x of columnRefs(expr).reverse())
    if (x.text === from) out = out.slice(0, x.start) + ident(to) + out.slice(x.end);
  return out;
};

// ───── 命名 ─────

const schemaOf = (m: Model, tableId: string) => get(m, tableId, 'table').parent;

/** 某个名字在关系命名空间（同 schema 的表、序列、索引）里是否被别的对象占用 */
const relTaken = (m: Model, schema: string, name: string, self: string) =>
  Object.values(m.objects).some((o) => {
    if (o.id === self) return false;
    if ((o.kind === 'table' || o.kind === 'sequence') && o.parent === schema) return o.name === name;
    if (
      (o.kind === 'index' || o.kind === 'primaryKey' || o.kind === 'unique') &&
      schemaOf(m, o.parent) === schema
    )
      return o.name === name;
    if (o.kind === 'column' && o.identity && self !== `${o.id}#seq` && schemaOf(m, o.parent) === schema)
      return o.identity.sequenceName === name;
    return false;
  });
/** 某个名字在表的约束命名空间里是否被别的对象占用 */
const conTaken = (m: Model, table: string, name: string, self: string) =>
  Object.values(m.objects).some((o) => {
    if (o.id === self) return false;
    if (
      (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'foreignKey') &&
      o.parent === table
    )
      return o.name === name;
    if (o.kind === 'column' && o.parent === table && o.notNull && self !== `${o.id}#nn`)
      return o.notNullName === name;
    return false;
  });

/** 重新计算一张表上所有推导名（改表名、改列名、改约束列之后调用） */
export const refreshDerivedNames = (m: Model, tableId: string) => {
  const t = get(m, tableId, 'table');
  const schema = t.parent;
  const choose = (id: string, n1: string, n2: string | null, label: string, rel: boolean, con: boolean) =>
    chooseName(
      n1,
      n2,
      label,
      (n) => (rel && relTaken(m, schema, n, id)) || (con && conTaken(m, tableId, n, id)),
    );
  for (const c of columnsOf(m, tableId)) {
    if (c.notNull && c.notNullNameMode === 'derived')
      c.notNullName = choose(`${c.id}#nn`, t.name, c.name, 'not_null', false, true);
    if (c.identity?.sequenceNameMode === 'derived')
      c.identity.sequenceName = choose(`${c.id}#seq`, t.name, c.name, 'seq', true, false);
    for (const s of all(m, 'sequence'))
      if (s.ownedBy === c.id && s.nameMode === 'derived')
        s.name = choose(s.id, t.name, c.name, 'seq', true, false);
  }
  for (const o of Object.values(m.objects)) {
    if (!('parent' in o) || o.parent !== tableId || !('nameMode' in o) || o.nameMode !== 'derived') continue;
    switch (o.kind) {
      case 'primaryKey':
        o.name = choose(o.id, t.name, null, 'pkey', true, true);
        break;
      case 'unique':
        o.name = choose(o.id, t.name, joinCols(m, o.columns), 'key', true, true);
        break;
      case 'foreignKey':
        o.name = choose(o.id, t.name, joinCols(m, o.columns), 'fkey', false, true);
        break;
      case 'check': {
        const refs = columnsOf(m, tableId).filter((c) => exprReferences(o.expr, c.name));
        o.name = choose(o.id, t.name, refs.length === 1 ? refs[0]!.name : null, 'check', false, true);
        break;
      }
      case 'index':
        o.name = choose(o.id, t.name, joinIdx(indexElementNames(m, o)), 'idx', true, false);
        break;
    }
  }
};
const joinCols = (m: Model, ids: string[]) => joinNames(ids.map((c) => colName(m, c)));
const joinIdx = (names: string[]) => joinNames(names);

// ───── schema ─────

export const createSchema = (m: Model, name: string, id = newId()): string => {
  if (all(m, 'schema').some((s) => s.name === name)) throw new EditError(`schema ${name} 已存在`);
  const o: Schema = { id, kind: 'schema', name, comment: null };
  m.objects[o.id] = o;
  return o.id;
};

export const renameSchema = (m: Model, id: string, name: string) => {
  if (all(m, 'schema').some((s) => s.name === name && s.id !== id))
    throw new EditError(`schema ${name} 已存在`);
  const s = get(m, id, 'schema');
  const old = s.name;
  s.name = name;
  rewriteExprs(m, (e) => renameQualifiedInExpr(e, old, null, { schema: name, name: null }));
};

export const dropSchema = (m: Model, id: string) => {
  for (const t of childrenOf(m, id, 'table')) dropTable(m, t.id);
  for (const s of childrenOf(m, id, 'sequence')) dropSequence(m, s.id);
  for (const e of childrenOf(m, id, 'enum')) dropEnum(m, e.id);
  delete m.objects[id];
};

// ───── 枚举、序列 ─────

const typeTaken = (m: Model, schema: string, name: string, self: string) =>
  Object.values(m.objects).some(
    (o) =>
      o.id !== self && (o.kind === 'enum' || o.kind === 'table') && o.parent === schema && o.name === name,
  );

export const createEnum = (
  m: Model,
  schema: string,
  name: string,
  values: string[],
  id = newId(),
): string => {
  get(m, schema, 'schema');
  if (typeTaken(m, schema, name, '')) throw new EditError(`类型名 ${name} 已被占用`);
  if (!values.length || new Set(values).size !== values.length) throw new EditError('枚举值不能为空或重复');
  const o: Enum = { id, kind: 'enum', parent: schema, name, values, comment: null };
  m.objects[o.id] = o;
  return o.id;
};

export const renameEnum = (m: Model, id: string, name: string) => {
  const e = get(m, id, 'enum');
  if (typeTaken(m, e.parent, name, id)) throw new EditError(`类型名 ${name} 已被占用`);
  const schema = get(m, e.parent, 'schema').name;
  const old = e.name;
  e.name = name;
  rewriteExprs(m, (x) => renameQualifiedInExpr(x, schema, old, { schema, name }));
};

/** 在第 index 个位置插入新值（PG 只支持新增，不支持删除或重排） */
export const addEnumValue = (m: Model, id: string, value: string, index?: number) => {
  const e = get(m, id, 'enum');
  if (e.values.includes(value)) throw new EditError(`枚举值 ${value} 已存在`);
  e.values.splice(index ?? e.values.length, 0, value);
};

export const dropEnum = (m: Model, id: string) => {
  get(m, id, 'enum');
  if (all(m, 'column').some((c) => c.typeRef === id)) throw new EditError('枚举仍被列使用');
  delete m.objects[id];
};

export const createSequence = (
  m: Model,
  schema: string,
  name: string,
  options: Partial<SequenceOptions> = {},
  id = newId(),
): string => {
  get(m, schema, 'schema');
  if (relTaken(m, schema, name, '')) throw new EditError(`名字 ${name} 已被占用`);
  const o: Sequence = {
    id,
    kind: 'sequence',
    parent: schema,
    name,
    nameMode: 'explicit',
    ownedBy: null,
    options: {
      type: 'bigint',
      increment: '1',
      min: null,
      max: null,
      start: null,
      cache: '1',
      cycle: false,
      ...options,
    },
    comment: null,
  };
  m.objects[o.id] = o;
  return o.id;
};

export const renameSequence = (m: Model, id: string, name: string) => {
  const s = get(m, id, 'sequence');
  if (relTaken(m, s.parent, name, id)) throw new EditError(`名字 ${name} 已被占用`);
  s.name = name;
  s.nameMode = 'explicit';
};

export const dropSequence = (m: Model, id: string) => {
  get(m, id, 'sequence');
  for (const c of all(m, 'column'))
    if (c.default && 'nextval' in c.default && c.default.nextval === id) c.default = null;
  delete m.objects[id];
};

// ───── 表 ─────

export const createTable = (m: Model, schema: string, name: string, id = newId()): string => {
  get(m, schema, 'schema');
  if (relTaken(m, schema, name, '') || typeTaken(m, schema, name, ''))
    throw new EditError(`名字 ${name} 已被占用`);
  const o: Table = {
    id,
    kind: 'table',
    parent: schema,
    name,
    partitionBy: null,
    partitionOf: null,
    comment: null,
  };
  m.objects[o.id] = o;
  return o.id;
};

export const renameTable = (m: Model, id: string, name: string) => {
  const t = get(m, id, 'table');
  if (relTaken(m, t.parent, name, id) || typeTaken(m, t.parent, name, id))
    throw new EditError(`名字 ${name} 已被占用`);
  t.name = name;
  refreshDerivedNames(m, id);
};

/** 删除依赖这些对象的不透明对象（视图、触发器等），与 PG 的 CASCADE 一致 */
const dropDependentOpaques = (m: Model, ids: Set<string>) => {
  for (let changed = true; changed; ) {
    changed = false;
    for (const o of all(m, 'opaque')) {
      if (o.deps.some((d) => ids.has(d)) || ids.has(o.parent)) {
        ids.add(o.id);
        delete m.objects[o.id];
        changed = true;
      }
    }
  }
};

export const dropTable = (m: Model, id: string) => {
  get(m, id, 'table');
  dropDependentOpaques(m, new Set([id, ...childrenOf(m, id, 'column').map((c) => c.id)]));
  for (const fk of all(m, 'foreignKey')) if (fk.refTable === id && fk.parent !== id) delete m.objects[fk.id];
  for (const c of childrenOf(m, id, 'column')) {
    for (const s of all(m, 'sequence')) if (s.ownedBy === c.id) delete m.objects[s.id];
    delete m.objects[c.id];
  }
  for (const o of Object.values(m.objects)) if ('parent' in o && o.parent === id) delete m.objects[o.id];
  delete m.objects[id];
};

// ───── 列 ─────

export interface ColumnSpec {
  name: string;
  type: string;
  typeRef?: string | null;
  notNull?: boolean;
  default?: ColumnDefault | null;
  identity?: { always: boolean } | null;
  generated?: { expr: string; stored: boolean } | null;
  collation?: string | null;
  /** 放在这一列之前；不传则放在最后 */
  before?: string;
  /** 指定 ID（同步层要求客户端和服务器执行同一修改时生成相同的 ID） */
  id?: string;
}

export const addColumn = (m: Model, table: string, spec: ColumnSpec): string => {
  const t = get(m, table, 'table');
  const cols = columnsOf(m, table);
  if (cols.some((c) => c.name === spec.name)) throw new EditError(`列 ${spec.name} 已存在`);
  let pos: string;
  if (spec.before) {
    const i = cols.findIndex((c) => c.id === spec.before);
    pos = generateKeyBetween(cols[i - 1]?.pos ?? null, cols[i]!.pos);
  } else pos = generateKeyBetween(cols.at(-1)?.pos ?? null, null);
  const c: Column = {
    id: spec.id ?? newId(),
    kind: 'column',
    parent: table,
    name: spec.name,
    pos,
    type: spec.type,
    typeRef: spec.typeRef ?? null,
    notNull: !!(spec.notNull || spec.identity),
    notNullName: null,
    notNullNameMode: 'derived',
    default: spec.identity || spec.generated ? null : (spec.default ?? null),
    identity: spec.identity
      ? {
          always: spec.identity.always,
          sequenceName: '',
          sequenceNameMode: 'derived',
          options: {
            type: 'bigint',
            increment: '1',
            min: null,
            max: null,
            start: null,
            cache: '1',
            cycle: false,
          },
        }
      : null,
    generated: spec.generated ?? null,
    collation: spec.collation ?? null,
    comment: null,
  };
  if (c.identity) c.identity.options.type = identityType(c.type);
  m.objects[c.id] = c;
  refreshDerivedNames(m, t.id);
  return c.id;
};

const identityType = (type: string): SequenceOptions['type'] =>
  type === 'smallint' ? 'smallint' : type === 'integer' ? 'integer' : 'bigint';

export const renameColumn = (m: Model, id: string, name: string) => {
  const c = get(m, id, 'column');
  if (columnsOf(m, c.parent).some((x) => x.name === name && x.id !== id))
    throw new EditError(`列 ${name} 已存在`);
  const old = c.name;
  c.name = name;
  // 同表表达式里对这一列的引用一起改写
  for (const o of Object.values(m.objects)) {
    if (!('parent' in o) || o.parent !== c.parent) continue;
    if (o.kind === 'check') o.expr = renameInExpr(o.expr, old, name);
    if (o.kind === 'index') {
      for (const e of o.elements) if (e.expr) e.expr = renameInExpr(e.expr, old, name);
      if (o.where) o.where = renameInExpr(o.where, old, name);
    }
    if (o.kind === 'column') {
      if (o.generated) o.generated.expr = renameInExpr(o.generated.expr, old, name);
      if (o.default && 'expr' in o.default) o.default.expr = renameInExpr(o.default.expr, old, name);
    }
  }
  refreshDerivedNames(m, c.parent);
};

/** 删列：依赖它的约束、索引、外键、生成列、属于它的序列一并删除 */
export const dropColumn = (m: Model, id: string) => {
  const c = get(m, id, 'column');
  const uses = (o: Obj): boolean => {
    switch (o.kind) {
      case 'primaryKey':
      case 'unique':
        return o.columns.includes(id);
      case 'foreignKey':
        return o.columns.includes(id) || o.refColumns.includes(id);
      case 'check':
        return o.parent === c.parent && exprReferences(o.expr, c.name);
      case 'index':
        return (
          o.parent === c.parent &&
          (o.elements.some((e) => e.column === id || (e.expr && exprReferences(e.expr, c.name))) ||
            o.include.includes(id) ||
            (!!o.where && exprReferences(o.where, c.name)))
        );
      case 'column':
        return (
          o.id !== id && o.parent === c.parent && !!o.generated && exprReferences(o.generated.expr, c.name)
        );
      case 'sequence':
        return o.ownedBy === id;
      default:
        return false;
    }
  };
  for (const o of Object.values(m.objects)) {
    if (!uses(o)) continue;
    if (o.kind === 'column') dropColumn(m, o.id);
    else delete m.objects[o.id];
  }
  dropDependentOpaques(m, new Set([id]));
  delete m.objects[id];
};

export const setColumnType = (m: Model, id: string, type: string, typeRef: string | null = null) => {
  const c = get(m, id, 'column');
  if (typeRef) get(m, typeRef, 'enum');
  c.type = type;
  c.typeRef = typeRef;
  if (c.identity) c.identity.options.type = identityType(type);
};

export const setNotNull = (m: Model, id: string, notNull: boolean) => {
  const c = get(m, id, 'column');
  if (!notNull) {
    if (c.identity) throw new EditError('identity 列必须 NOT NULL');
    if (all(m, 'primaryKey').some((k) => k.columns.includes(id))) throw new EditError('主键列必须 NOT NULL');
  }
  c.notNull = notNull;
  c.notNullName = null;
  c.notNullNameMode = 'derived';
  refreshDerivedNames(m, c.parent);
};

export const setDefault = (m: Model, id: string, def: ColumnDefault | null) => {
  const c = get(m, id, 'column');
  if (def && (c.identity || c.generated)) throw new EditError('identity 列和生成列不能有默认值');
  if (def && 'nextval' in def) get(m, def.nextval, 'sequence');
  c.default = def;
};

export const setIdentity = (m: Model, id: string, identity: { always: boolean } | null) => {
  const c = get(m, id, 'column');
  if (!identity) {
    c.identity = null;
    return;
  }
  if (c.generated) throw new EditError('生成列不能是 identity');
  if (c.identity) {
    c.identity.always = identity.always;
    return;
  }
  c.default = null;
  c.notNull = true;
  c.identity = {
    always: identity.always,
    sequenceName: '',
    sequenceNameMode: 'derived',
    options: {
      type: identityType(c.type),
      increment: '1',
      min: null,
      max: null,
      start: null,
      cache: '1',
      cycle: false,
    },
  };
  refreshDerivedNames(m, c.parent);
};

export const moveColumn = (m: Model, id: string, before: string | null) => {
  const c = get(m, id, 'column');
  if (before === id) return;
  const cols = columnsOf(m, c.parent).filter((x) => x.id !== id);
  let i = before ? cols.findIndex((x) => x.id === before) : -1;
  if (i < 0) i = cols.length;
  c.pos = generateKeyBetween(cols[i - 1]?.pos ?? null, cols[i]?.pos ?? null);
};

// ───── 约束和索引 ─────

const keyBase = (table: string, id = newId()) => ({
  id,
  parent: table,
  name: '',
  nameMode: 'derived' as const,
  comment: null,
});
const checkCols = (m: Model, table: string, cols: string[]) => {
  if (!cols.length) throw new EditError('至少需要一列');
  for (const c of cols) if (get(m, c, 'column').parent !== table) throw new EditError('列不属于这张表');
};

export const addPrimaryKey = (m: Model, table: string, columns: string[], id = newId()): string => {
  checkCols(m, table, columns);
  if (childrenOf(m, table, 'primaryKey').length) throw new EditError('表已有主键');
  for (const c of columns) {
    const col = get(m, c, 'column');
    if (!col.notNull) {
      col.notNull = true;
      col.notNullNameMode = 'derived';
    }
  }
  const o: PrimaryKey = { ...keyBase(table, id), kind: 'primaryKey', columns };
  m.objects[o.id] = o;
  refreshDerivedNames(m, table);
  return o.id;
};

export const addUnique = (
  m: Model,
  table: string,
  columns: string[],
  nullsNotDistinct = false,
  id = newId(),
): string => {
  checkCols(m, table, columns);
  const o: Unique = { ...keyBase(table, id), kind: 'unique', columns, nullsNotDistinct };
  m.objects[o.id] = o;
  refreshDerivedNames(m, table);
  return o.id;
};

export const addCheck = (m: Model, table: string, expr: string, id = newId()): string => {
  get(m, table, 'table');
  checkExprColumns(m, table, expr);
  const o: Check = { ...keyBase(table, id), kind: 'check', expr, noInherit: false };
  m.objects[o.id] = o;
  refreshDerivedNames(m, table);
  return o.id;
};

export const addForeignKey = (
  m: Model,
  table: string,
  columns: string[],
  refTable: string,
  refColumns: string[],
  opts: Partial<
    Pick<ForeignKey, 'onDelete' | 'onUpdate' | 'match' | 'deferrable' | 'initiallyDeferred'>
  > = {},
  id = newId(),
): string => {
  checkCols(m, table, columns);
  checkCols(m, refTable, refColumns);
  if (columns.length !== refColumns.length) throw new EditError('两边列数必须相同');
  const o: ForeignKey = {
    ...keyBase(table, id),
    kind: 'foreignKey',
    columns,
    refTable,
    refColumns,
    onDelete: 'noAction',
    onUpdate: 'noAction',
    match: 'simple',
    deferrable: false,
    initiallyDeferred: false,
    ...opts,
  };
  m.objects[o.id] = o;
  refreshDerivedNames(m, table);
  return o.id;
};

export const addIndex = (
  m: Model,
  table: string,
  elements: Partial<IndexElement>[],
  opts: Partial<Pick<Index, 'unique' | 'method' | 'include' | 'where' | 'nullsNotDistinct'>> = {},
  id = newId(),
): string => {
  get(m, table, 'table');
  const o: Index = {
    ...keyBase(table, id),
    kind: 'index',
    unique: false,
    method: 'btree',
    include: [],
    where: null,
    nullsNotDistinct: false,
    ...opts,
    elements: elements.map((e) => ({
      column: null,
      expr: null,
      desc: false,
      nullsFirst: null,
      opclass: null,
      collation: null,
      ...e,
    })),
  };
  m.objects[o.id] = o;
  refreshDerivedNames(m, table);
  return o.id;
};

/** 删约束或索引；删主键、唯一约束、唯一索引时，依赖它的外键一并删除 */
export const dropKey = (m: Model, id: string) => {
  const o = get(m, id);
  if (
    !(
      o.kind === 'primaryKey' ||
      o.kind === 'unique' ||
      o.kind === 'foreignKey' ||
      o.kind === 'check' ||
      o.kind === 'index'
    )
  )
    throw new EditError('不是约束或索引');
  const keyCols =
    o.kind === 'primaryKey' || o.kind === 'unique'
      ? o.columns
      : o.kind === 'index' && o.unique && o.elements.every((e) => e.column) && !o.where
        ? o.elements.map((e) => e.column!)
        : null;
  if (keyCols) {
    const set = [...keyCols].sort().join();
    for (const fk of all(m, 'foreignKey'))
      if (fk.refTable === o.parent && [...fk.refColumns].sort().join() === set) delete m.objects[fk.id];
  }
  delete m.objects[id];
};

/** 给约束或索引起一个显式名字（之后不再跟着改名） */
export const renameKey = (m: Model, id: string, name: string) => {
  const o = get(m, id);
  if (
    !(
      o.kind === 'primaryKey' ||
      o.kind === 'unique' ||
      o.kind === 'foreignKey' ||
      o.kind === 'check' ||
      o.kind === 'index'
    )
  )
    throw new EditError('不是约束或索引');
  const rel = o.kind !== 'check' && o.kind !== 'foreignKey';
  const con = o.kind !== 'index';
  if ((rel && relTaken(m, schemaOf(m, o.parent), name, id)) || (con && conTaken(m, o.parent, name, id)))
    throw new EditError(`名字 ${name} 已被占用`);
  o.name = name;
  o.nameMode = 'explicit';
};

/** 把名字恢复为自动推导 */
export const resetKeyName = (m: Model, id: string) => {
  const o = get(m, id);
  if ('nameMode' in o && o.kind !== 'sequence') {
    o.nameMode = 'derived';
    refreshDerivedNames(m, o.parent);
  }
};

export const setComment = (m: Model, id: string, comment: string | null) => {
  get(m, id).comment = comment;
};

export const findTable = (m: Model, schema: string, name: string): Table | undefined =>
  all(m, 'table').find((t) => t.name === name && find(m, t.parent)?.name === schema);
