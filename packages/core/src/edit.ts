// 编辑操作：在模型上做一次有语义的修改（直接修改传入的模型）。
// 这些操作就是同步层的 mutator（04-ir-design.md 第 2 节）：客户端乐观执行，服务器在最新状态上重新执行并校验。
import { generateKeyBetween } from 'fractional-indexing';

import type { IdentKind } from './dialect.ts';
import { EditError } from './errors.ts';
import { isReservedId, newId } from './ids.ts';
import {
  type Check,
  type Column,
  type ColumnDefault,
  type ColumnExt,
  type Enum,
  type ForeignKey,
  type Index,
  type IndexElement,
  type IndexExt,
  isValidIndexElement,
  type Model,
  type Obj,
  type PartitionSpec,
  type PrimaryKey,
  type PrimaryKeyExt,
  type Schema,
  type Sequence,
  type SequenceOptions,
  type Table,
  type TableExt,
  type Unique,
  type UniqueExt,
} from './ir.ts';
import { clonePlain, deepEqual } from './json.ts';
import {
  all,
  allChildrenOf,
  childrenOf,
  columnsOf,
  effectiveColumnsOf,
  find,
  get,
  getActiveModelIndex,
  partitionDescendants,
  partitionsOf,
  requiredUniquePartitionKeys,
  rootTableId,
} from './model.ts';
import { effectiveNotNull, setMssqlInferredNotNull, stripMssqlInferredNotNull } from './mssql/nullability.ts';
import { MYSQL_SAFE_IDENT_RE } from './mysql/naming.ts';
import { exprReferences, renameInExpr, renameQualifiedInExpr, type Token, tokenize } from './pg/expr.ts';
import {
  derivedUuid,
  parsePartitionBound,
  partitionKeyColumns,
  resolvePartitionBy,
  validatePartitionBound,
} from './pg/partition.ts';
import { isPgSerialArrayType, parsePgSerialType, PG_SERIAL_BASE, type PgSerialBase } from './pg/serial.ts';
import { getDialect } from './registry.ts';
import { SQLITE_STRICT_TYPES, sqliteNormalizeCollation, sqliteNormalizeType } from './sqlite/types.ts';

export { EditError, exprReferences, renameInExpr, renameQualifiedInExpr, type Token, tokenize };

// ───── 表达式里的标识符 ─────

/**
 * 校验表达式里的列引用都是本表存在的列（关键字除外）。
 * 只能发现明显的错误（如列已被改名、删除）；完整的语义校验由影子库完成。
 */
export const checkExprColumns = (m: Model, table: string, expr: string) => {
  const d = getDialect(m.dialect);
  const caseInsensitive = m.dialect === 'sqlite' || m.dialect === 'mysql' || m.dialect === 'mssql';
  const names = new Set(
    effectiveColumnsOf(m, table).map((c) => (caseInsensitive ? c.name.toLowerCase() : c.name)),
  );
  const unknown = d
    .columnRefs(expr)
    .filter((t) => {
      const k = caseInsensitive ? t.text.toLowerCase() : t.text;
      return !names.has(k) && !(t.kind === 'ident' && d.keywords.has(t.text.toLowerCase()));
    })
    .map((t) => t.text);
  if (unknown.length) throw new EditError(`表达式引用了不存在的列：${[...new Set(unknown)].join('、')}`);
};

/** 对模型里所有表达式应用同一个改写 */
export const rewriteExprs = (m: Model, f: (expr: string) => string) => {
  for (const t of all(m, 'table')) {
    if (typeof t.partitionBy === 'string') normalizePartitionFamily(m, t.id);
  }
  for (const t of all(m, 'table')) {
    if (t.partitionBy && typeof t.partitionBy !== 'string') {
      for (const k of t.partitionBy.keys) if (k.expr) k.expr = f(k.expr);
    }
  }
  for (const o of all(m, 'check')) o.expr = f(o.expr);
  for (const o of all(m, 'index')) {
    for (const e of o.elements) if (e.expr) e.expr = f(e.expr);
    if (o.where) o.where = f(o.where);
  }
  for (const o of all(m, 'column')) {
    if (o.generated) o.generated.expr = f(o.generated.expr);
    if (o.default && 'expr' in o.default) o.default.expr = f(o.default.expr);
  }
};

// ───── 命名 ─────

const schemaOf = (m: Model, tableId: string) => get(m, tableId, 'table').parent;

const relTaken = (m: Model, schema: string, name: string, self: string) =>
  getDialect(m.dialect).isNameTaken(m, 'rel', schema, name, self);

const conTaken = (m: Model, table: string, name: string, self: string) =>
  getDialect(m.dialect).isNameTaken(m, 'con', table, name, self);

const typeTaken = (m: Model, schema: string, name: string, self: string) =>
  getDialect(m.dialect).isNameTaken(m, 'type', schema, name, self);

const assertIdent = (m: Model, name: string, kind: IdentKind) => {
  const err = getDialect(m.dialect).validateIdent(name, kind);
  if (err) throw new EditError(err);
};

const assertMysqlSafeOption = (val: string | null | undefined, label: string) => {
  if (val !== undefined && val !== null && !MYSQL_SAFE_IDENT_RE.test(val)) {
    throw new EditError(`MySQL ${label} ${val} 格式不合法（仅允许 1-64 位字母、数字与下划线）`);
  }
};

/** 清除列上的 SQLite AUTOINCREMENT 标记（表变为 WITHOUT ROWID、主键改为多列或换列、或列类型不再为 INTEGER 时调用） */
const clearSqliteAutoincrement = (c: Column) => {
  if (!c.ext?.sqlite?.autoincrement) return;
  const nextExt = { ...c.ext, sqlite: { ...c.ext.sqlite, autoincrement: undefined } };
  const cleaned = cleanExt(nextExt);
  if (cleaned) c.ext = cleaned as ColumnExt;
  else delete c.ext;
};

/** 重新计算一张表上所有推导名（改表名、改列名、改约束列之后调用） */
export const refreshDerivedNames = (m: Model, tableId: string) => {
  getDialect(m.dialect).refreshDerivedNames(m, tableId);
};

// ───── schema ─────

export const createSchema = (m: Model, name: string, id = newId()): string => {
  const cap = getDialect(m.dialect).capabilities;
  if (!cap.schemas && name !== cap.defaultSchema) {
    throw new EditError(`当前方言不支持多 schema（固定为 ${cap.defaultSchema}）`);
  }
  assertIdent(m, name, 'schema');
  const ci = m.dialect === 'sqlite' || m.dialect === 'mssql';
  if (all(m, 'schema').some((s) => (ci ? s.name.toLowerCase() === name.toLowerCase() : s.name === name)))
    throw new EditError(`schema ${name} 已存在`);
  const o: Schema = { id, kind: 'schema', name, comment: null };
  m.objects[o.id] = o;
  return o.id;
};

export const renameSchema = (m: Model, id: string, name: string) => {
  if (!getDialect(m.dialect).capabilities.schemas) {
    throw new EditError('当前方言不支持重命名 schema');
  }
  assertIdent(m, name, 'schema');
  const ci = m.dialect === 'sqlite' || m.dialect === 'mssql';
  if (
    all(m, 'schema').some(
      (s) => (ci ? s.name.toLowerCase() === name.toLowerCase() : s.name === name) && s.id !== id,
    )
  )
    throw new EditError(`schema ${name} 已存在`);
  const s = get(m, id, 'schema');
  const old = s.name;
  s.name = name;
  const d = getDialect(m.dialect);
  rewriteExprs(m, (e) => d.renameQualifiedInExpr(e, old, null, { schema: name, name: null }));
};

export const dropSchema = (m: Model, id: string) => {
  if (!getDialect(m.dialect).capabilities.schemas) {
    throw new EditError('当前方言不支持删除默认 schema');
  }
  for (const t of childrenOf(m, id, 'table')) dropTable(m, t.id);
  for (const s of childrenOf(m, id, 'sequence')) dropSequence(m, s.id);
  for (const e of childrenOf(m, id, 'enum')) dropEnum(m, e.id);
  delete m.objects[id];
};

// ───── 枚举、序列 ─────

export const createEnum = (
  m: Model,
  schema: string,
  name: string,
  values: string[],
  id = newId(),
): string => {
  if (!getDialect(m.dialect).capabilities.enums) throw new EditError('当前方言不支持独立枚举类型');
  get(m, schema, 'schema');
  assertIdent(m, name, 'enum');
  if (typeTaken(m, schema, name, '')) throw new EditError(`类型名 ${name} 已被占用`);
  if (!values.length || new Set(values).size !== values.length) throw new EditError('枚举值不能为空或重复');
  const o: Enum = { id, kind: 'enum', parent: schema, name, values, comment: null };
  m.objects[o.id] = o;
  return o.id;
};

export const renameEnum = (m: Model, id: string, name: string) => {
  if (!getDialect(m.dialect).capabilities.enums) throw new EditError('当前方言不支持独立枚举类型');
  assertIdent(m, name, 'enum');
  const e = get(m, id, 'enum');
  if (typeTaken(m, e.parent, name, id)) throw new EditError(`类型名 ${name} 已被占用`);
  const schema = get(m, e.parent, 'schema').name;
  const old = e.name;
  e.name = name;
  const d = getDialect(m.dialect);
  rewriteExprs(m, (x) => d.renameQualifiedInExpr(x, schema, old, { schema, name }));
};

/** 在第 index 个位置插入新值（PG 只支持新增，不支持删除或重排） */
export const addEnumValue = (m: Model, id: string, value: string, index?: number) => {
  if (!getDialect(m.dialect).capabilities.enums) throw new EditError('当前方言不支持独立枚举类型');
  const e = get(m, id, 'enum');
  if (e.values.includes(value)) throw new EditError(`枚举值 ${value} 已存在`);
  e.values.splice(index ?? e.values.length, 0, value);
};

export const dropEnum = (m: Model, id: string) => {
  if (!getDialect(m.dialect).capabilities.enums) throw new EditError('当前方言不支持独立枚举类型');
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
  if (!getDialect(m.dialect).capabilities.sequences) throw new EditError('当前方言不支持独立序列');
  get(m, schema, 'schema');
  assertIdent(m, name, 'sequence');
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
  if (!getDialect(m.dialect).capabilities.sequences) throw new EditError('当前方言不支持独立序列');
  assertIdent(m, name, 'sequence');
  const s = get(m, id, 'sequence');
  if (relTaken(m, s.parent, name, id)) throw new EditError(`名字 ${name} 已被占用`);
  s.name = name;
  s.nameMode = 'explicit';
};

export const dropSequence = (m: Model, id: string) => {
  if (!getDialect(m.dialect).capabilities.sequences) throw new EditError('当前方言不支持独立序列');
  get(m, id, 'sequence');
  const affectedTables = new Set<string>();
  for (const c of all(m, 'column')) {
    if (c.default && 'nextval' in c.default && c.default.nextval === id) {
      c.default = null;
      affectedTables.add(c.parent);
    }
  }
  delete m.objects[id];
  for (const tid of affectedTables) refreshDerivedNames(m, tid);
};

export const setSequenceOwnedBy = (m: Model, id: string, column: string | null) => {
  if (!getDialect(m.dialect).capabilities.sequences) throw new EditError('当前方言不支持独立序列');
  const s = get(m, id, 'sequence');
  if (column !== null) {
    const c = get(m, column, 'column');
    const t = get(m, c.parent, 'table');
    if (t.parent !== s.parent) throw new EditError('序列与归属列必须在同一个 schema 中');
  }
  s.ownedBy = column;
};

// ───── 表 ─────

export const createTable = (
  m: Model,
  schema: string,
  name: string,
  id = newId(),
  partitionBy: PartitionSpec | null = null,
  ext?: TableExt,
): string => {
  get(m, schema, 'schema');
  assertIdent(m, name, 'table');
  if (isReservedId(id)) throw new EditError(`对象 ID ${id} 是保留名`);
  if (Object.hasOwn(m.objects, id)) throw new EditError(`对象 ID ${id} 已存在`);
  if (relTaken(m, schema, name, '') || typeTaken(m, schema, name, ''))
    throw new EditError(`名字 ${name} 已被占用`);
  if (m.dialect === 'mysql' && ext?.mysql) {
    assertMysqlSafeOption(ext.mysql.engine, '存储引擎名');
    assertMysqlSafeOption(ext.mysql.charset, '字符集名');
    assertMysqlSafeOption(ext.mysql.collation, '排序规则名');
  }
  const o: Table = {
    id,
    kind: 'table',
    parent: schema,
    name,
    partitionBy: null,
    partitionOf: null,
    comment: null,
    ...(ext !== undefined ? { ext } : {}),
  };
  m.objects[o.id] = o;
  if (partitionBy !== null) {
    try {
      setPartitionBy(m, o.id, partitionBy);
    } catch (e) {
      delete m.objects[o.id];
      throw e;
    }
  }
  return o.id;
};

/** 更新表的方言专属扩展选项（如 SQLite STRICT / WITHOUT ROWID、MySQL ENGINE / CHARSET） */
export const setTableExt = (m: Model, id: string, ext: TableExt | null) => {
  const t = get(m, id, 'table');
  if (m.dialect === 'sqlite' && ext?.sqlite) {
    if (ext.sqlite.withoutRowid) {
      const pks = childrenOf(m, id, 'primaryKey');
      if (pks.length === 0) throw new EditError('WITHOUT ROWID 表必须先定义主键');
      for (const c of columnsOf(m, id)) {
        if (c.ext?.sqlite?.autoincrement) {
          throw new EditError(`列 ${c.name} 启用了 AUTOINCREMENT，不能开启 WITHOUT ROWID`);
        }
      }
    }
    if (ext.sqlite.strict) {
      for (const c of columnsOf(m, id)) {
        const normalized = c.type.trim().toUpperCase();
        if (!normalized) {
          throw new EditError(
            `列 ${c.name} 未声明类型，STRICT 表要求声明 INT/INTEGER/REAL/TEXT/BLOB/ANY 之一`,
          );
        }
        if (!SQLITE_STRICT_TYPES.has(normalized)) {
          throw new EditError(
            `列 ${c.name} 的类型 ${c.type} 不符合 STRICT 表要求（仅允许 INT/INTEGER/REAL/TEXT/BLOB/ANY）`,
          );
        }
      }
    }
  }
  if (m.dialect === 'mysql' && ext?.mysql) {
    assertMysqlSafeOption(ext.mysql.engine, '存储引擎名');
    assertMysqlSafeOption(ext.mysql.charset, '字符集名');
    assertMysqlSafeOption(ext.mysql.collation, '排序规则名');
  }
  const cleaned = cleanExt(ext);
  if (cleaned) t.ext = cleaned as TableExt;
  else delete t.ext;
};

/** 清理方言扩展：去掉值为 undefined 的键与空的方言子对象；整体为空时返回 undefined */
export const cleanExt = <T extends Record<string, unknown>>(ext: T | null | undefined): T | undefined => {
  if (!ext) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ext)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([, iv]) => iv !== undefined),
      );
      if (Object.keys(inner).length > 0) out[k] = inner;
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? (out as T) : undefined;
};

export const renameTable = (m: Model, id: string, name: string) => {
  const t = get(m, id, 'table');
  assertIdent(m, name, 'table');
  normalizePartitionFamily(m, id);
  if (relTaken(m, t.parent, name, id) || typeTaken(m, t.parent, name, id))
    throw new EditError(`名字 ${name} 已被占用`);
  t.name = name;
  refreshDerivedNames(m, id);
};

/** 删除依赖这些对象的不透明对象（视图、触发器等），与 PG 的 CASCADE 一致 */
const dropDependentOpaques = (m: Model, ids: Set<string>) => {
  for (let changed = true; changed;) {
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

export const dropTable = (m: Model, id: string, seen = new Set<string>()) => {
  if (seen.has(id)) return;
  seen.add(id);
  get(m, id, 'table');
  // 级联删除其下所有子分区（支持多级），带环保护，不留悬空 partitionOf
  for (const child of partitionsOf(m, id)) dropTable(m, child.id, seen);
  dropDependentOpaques(m, new Set([id, ...childrenOf(m, id, 'column').map((c) => c.id)]));
  for (const fk of all(m, 'foreignKey')) if (fk.refTable === id && fk.parent !== id) delete m.objects[fk.id];
  for (const c of childrenOf(m, id, 'column')) {
    for (const s of all(m, 'sequence')) if (s.ownedBy === c.id) delete m.objects[s.id];
    delete m.objects[c.id];
  }
  for (const o of allChildrenOf(m, id)) delete m.objects[o.id];
  delete m.objects[id];
};

// ───── 分区 ─────

const assertNotPartitionChild = (m: Model, tableId: string) => {
  const t = get(m, tableId, 'table');
  if (t.partitionOf !== null)
    throw new EditError(`分区子表 ${t.name} 继承父表的列定义，不能直接添加、修改或删除列`);
};

const assertNotPartitionKeyCol = (m: Model, colId: string, action: string) => {
  const c = get(m, colId, 'column');
  const tables = [get(m, c.parent, 'table'), ...partitionDescendants(m, c.parent)];
  for (const t of tables) {
    if (!t.partitionBy) continue;
    const refs = partitionKeyColumns(m, t);
    if (refs.all.includes(colId)) {
      throw new EditError(`列 ${c.name} 被分区表 ${t.name} 的分区键引用，不能${action}`);
    }
  }
};

const assertSpecKeysValid = (m: Model, tableId: string, spec: PartitionSpec) => {
  if (!spec.keys.length) throw new EditError('至少需要一个分区键');
  if (spec.strategy === 'list' && spec.keys.length !== 1) throw new EditError('LIST 分区只能有 1 个分区键');
  const root = rootTableId(m, tableId);
  for (const k of spec.keys) {
    if (!!k.column === !!k.expr) throw new EditError('分区键必须且只能指定列或表达式之一');
    if (k.column) {
      const col = get(m, k.column, 'column');
      if (col.parent !== root && col.parent !== tableId) throw new EditError('分区键列不属于这张表');
      if (col.generated) throw new EditError(`生成列 ${col.name} 不能作为分区键`);
    } else if (k.expr) {
      checkExprColumns(m, tableId, k.expr);
    }
  }
};

/**
 * 幂等升级存量旧格式分区表家族：
 * 1) 清理子分区上的冗余列对象，并把其本地约束/索引/外键/序列归属/不透明对象依赖映射到根父表列 ID；
 * 2) 将 `typeof partitionBy === 'string'` 经 `resolvePartitionBy` 升级为结构化 `PartitionSpec`。
 */
export const normalizePartitionFamily = (m: Model, tableId: string) => {
  const rootId = rootTableId(m, tableId);
  const root = find(m, rootId);
  if (root?.kind !== 'table') return;
  const descendants = partitionDescendants(m, rootId);
  const family = [root, ...descendants];
  const hasLegacyString = family.some((t) => typeof t.partitionBy === 'string');
  const hasChildCols = descendants.some((d) => childrenOf(m, d.id, 'column').length > 0);
  if (!hasLegacyString && !hasChildCols) return;

  if (hasChildCols) {
    const rootColByName = new Map(columnsOf(m, rootId).map((c) => [c.name, c.id]));
    for (const ch of descendants) {
      const redundant = columnsOf(m, ch.id);
      if (!redundant.length) continue;
      const colMap = new Map<string, string>();
      for (const cc of redundant) {
        const rcId = rootColByName.get(cc.name);
        if (rcId) colMap.set(cc.id, rcId);
      }
      if (colMap.size > 0) {
        remapColRefsOnTable(m, ch.id, colMap);
        for (const fk of all(m, 'foreignKey')) {
          if (fk.refTable === ch.id && fk.refColumns.some((c) => colMap.has(c))) {
            fk.refColumns = fk.refColumns.map((c) => colMap.get(c) ?? c);
          }
        }
        for (const s of all(m, 'sequence')) {
          if (s.ownedBy && colMap.has(s.ownedBy)) s.ownedBy = colMap.get(s.ownedBy)!;
        }
        for (const o of all(m, 'opaque')) {
          if (o.deps.some((d) => colMap.has(d))) {
            o.deps = [...new Set(o.deps.map((d) => colMap.get(d) ?? d))];
          }
        }
      }
      for (const cc of redundant) delete m.objects[cc.id];
    }
  }

  for (const t of family) {
    if (typeof t.partitionBy === 'string') {
      const spec = resolvePartitionBy(m, t);
      if (spec) t.partitionBy = clonePlain(spec);
    }
  }
};

/**
 * 返回归一化后的模型副本：对模型中所有分区根表幂等执行 `normalizePartitionFamily`，
 * 统一升级存量 `partitionBy: string` 并清理子分区冗余列；不修改入参对象，
 * 且对无法结构化解析的残留 `partitionBy: string` 保持原样不抛错。
 */
export const normalizeAllPartitionFamilies = (m: Model): Model => {
  let needsWork = false;
  for (const id in m.objects) {
    const o = m.objects[id]!;
    if (o.kind === 'table' && typeof o.partitionBy === 'string') {
      needsWork = true;
      break;
    }
    if (o.kind === 'column') {
      const p = find(m, o.parent);
      if (p?.kind === 'table' && p.partitionOf !== null) {
        needsWork = true;
        break;
      }
    }
  }
  if (!needsWork) return m;
  const out = clonePlain(m);
  const seen = new Set<string>();
  for (const t of all(out, 'table')) {
    if (t.partitionBy === null && t.partitionOf === null) continue;
    const rootId = rootTableId(out, t.id);
    if (seen.has(rootId)) continue;
    seen.add(rootId);
    normalizePartitionFamily(out, rootId);
  }
  return out;
};

const assertPartitionConstraintCompat = (
  req: { directCols: string[]; hasExprKey: boolean },
  kind: 'primaryKey' | 'unique' | 'index',
  cols: string[],
  elements?: IndexElement[],
) => {
  const { hasExprKey, directCols } = req;
  if (kind === 'primaryKey' || kind === 'unique') {
    const label = kind === 'primaryKey' ? '主键' : '唯一约束';
    if (hasExprKey) throw new EditError(`包含表达式分区键的分区表不能创建${label}`);
    if (directCols.some((c) => !cols.includes(c)))
      throw new EditError(`分区表的${label}必须包含全部分区键列`);
    return;
  }
  if (hasExprKey) throw new EditError('包含表达式分区键的分区表不支持唯一索引');
  const els = elements ?? [];
  if (directCols.some((c) => !els.some((e) => e.column === c)))
    throw new EditError('分区表的唯一索引必须包含全部分区键');
};

const nextDetId = (m: Model, seed: string): string => {
  for (let i = 0; ; i++) {
    const candidate = derivedUuid(i === 0 ? seed : `${seed}#${i}`);
    if (!Object.hasOwn(m.objects, candidate)) return candidate;
  }
};

export const setPartitionBy = (m: Model, tableId: string, spec: PartitionSpec | null) => {
  if (!getDialect(m.dialect).capabilities.partitioning) throw new EditError('当前方言不支持分区表');
  const t = get(m, tableId, 'table');
  normalizePartitionFamily(m, tableId);
  const children = partitionsOf(m, tableId);
  if (spec === null) {
    if (children.length > 0) throw new EditError('表下仍有子分区，请先删除或脱离全部子分区再取消分区');
    t.partitionBy = null;
    return;
  }
  assertSpecKeysValid(m, tableId, spec);
  for (const child of children) {
    const err = validatePartitionBound(spec.strategy, child.partitionOf!.bound, spec.keys.length);
    if (err) throw new EditError(`现有子分区 ${child.name} 与新分区策略不兼容：${err}`);
  }
  for (const anc of ancestorsOf(m, tableId)) {
    const req = requiredUniquePartitionKeys(m, anc.id, { tableId, spec });
    for (const pk of childrenOf(m, anc.id, 'primaryKey'))
      assertPartitionConstraintCompat(req, 'primaryKey', pk.columns);
    for (const u of childrenOf(m, anc.id, 'unique'))
      assertPartitionConstraintCompat(req, 'unique', u.columns);
    for (const x of childrenOf(m, anc.id, 'index'))
      if (x.unique) assertPartitionConstraintCompat(req, 'index', [], x.elements);
  }
  for (const ck of childrenOf(m, tableId, 'check'))
    if (ck.noInherit) throw new EditError(`检查约束 ${ck.name} 设为 NO INHERIT，分区父表不支持`);
  t.partitionBy = clonePlain(spec);
};

export const createPartition = (
  m: Model,
  parentId: string,
  name: string,
  bound: string,
  id = newId(),
  schemaId?: string,
): string => {
  if (!getDialect(m.dialect).capabilities.partitioning) throw new EditError('当前方言不支持分区表');
  const parent = get(m, parentId, 'table');
  normalizePartitionFamily(m, parentId);
  if (isReservedId(id)) throw new EditError(`对象 ID ${id} 是保留名`);
  if (Object.hasOwn(m.objects, id)) throw new EditError(`对象 ID ${id} 已存在`);
  if (!parent.partitionBy) throw new EditError(`表 ${parent.name} 不是分区父表`);
  const spec = resolvePartitionBy(m, parent);
  if (!spec) throw new EditError(`无法解析表 ${parent.name} 的分区定义`);
  const trimmed = bound.trim();
  const err = validatePartitionBound(spec.strategy, trimmed, spec.keys.length);
  if (err) throw new EditError(err);
  if (
    parsePartitionBound(trimmed)?.kind === 'default' &&
    partitionsOf(m, parentId).some((c) => parsePartitionBound(c.partitionOf!.bound)?.kind === 'default')
  ) {
    throw new EditError(`表 ${parent.name} 已有 DEFAULT 子分区`);
  }
  const schema = schemaId ?? parent.parent;
  get(m, schema, 'schema');
  assertIdent(m, name, 'table');
  if (relTaken(m, schema, name, '') || typeTaken(m, schema, name, ''))
    throw new EditError(`名字 ${name} 已被占用`);
  const o: Table = {
    id,
    kind: 'table',
    parent: schema,
    name,
    partitionBy: null,
    partitionOf: { parent: parentId, bound: trimmed },
    comment: null,
  };
  m.objects[o.id] = o;
  return o.id;
};

export const setPartitionBound = (m: Model, childId: string, bound: string) => {
  if (!getDialect(m.dialect).capabilities.partitioning) throw new EditError('当前方言不支持分区表');
  const child = get(m, childId, 'table');
  normalizePartitionFamily(m, childId);
  if (!child.partitionOf) throw new EditError(`表 ${child.name} 不是分区子表`);
  const parent = get(m, child.partitionOf.parent, 'table');
  const spec = resolvePartitionBy(m, parent);
  if (!spec) throw new EditError(`无法解析表 ${parent.name} 的分区定义`);
  const trimmed = bound.trim();
  const err = validatePartitionBound(spec.strategy, trimmed, spec.keys.length);
  if (err) throw new EditError(err);
  if (
    parsePartitionBound(trimmed)?.kind === 'default' &&
    partitionsOf(m, parent.id).some(
      (c) => c.id !== childId && parsePartitionBound(c.partitionOf!.bound)?.kind === 'default',
    )
  ) {
    throw new EditError(`表 ${parent.name} 已有 DEFAULT 子分区`);
  }
  child.partitionOf = { parent: child.partitionOf.parent, bound: trimmed };
};

const ancestorsOf = (m: Model, tableId: string): Table[] => {
  const out: Table[] = [];
  const seen = new Set<string>();
  let cur: string | null = tableId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const t: Obj | undefined = find(m, cur);
    if (t?.kind !== 'table') break;
    out.push(t);
    cur = t.partitionOf?.parent ?? null;
  }
  return out;
};

const remapColRefsOnTable = (m: Model, tableId: string, colMap: Map<string, string>) => {
  const mapCol = (c: string) => colMap.get(c) ?? c;
  const targets = new Set([tableId, ...partitionDescendants(m, tableId).map((d) => d.id)]);
  for (const tid of targets) {
    const t = find(m, tid);
    if (t?.kind === 'table' && t.partitionBy && typeof t.partitionBy !== 'string') {
      for (const k of t.partitionBy.keys) if (k.column) k.column = mapCol(k.column);
    }
    for (const o of allChildrenOf(m, tid)) {
      if (o.kind === 'primaryKey' || o.kind === 'unique') o.columns = o.columns.map(mapCol);
      else if (o.kind === 'foreignKey') {
        o.columns = o.columns.map(mapCol);
        if (targets.has(o.refTable)) o.refColumns = o.refColumns.map(mapCol);
      } else if (o.kind === 'index') {
        for (const el of o.elements) if (el.column) el.column = mapCol(el.column);
        o.include = o.include.map(mapCol);
      }
    }
  }
};

export const attachPartition = (m: Model, parentId: string, childId: string, bound: string) => {
  if (!getDialect(m.dialect).capabilities.partitioning) throw new EditError('当前方言不支持分区表');
  const parent = get(m, parentId, 'table');
  const child = get(m, childId, 'table');
  normalizePartitionFamily(m, parentId);
  normalizePartitionFamily(m, childId);
  if (parentId === childId) throw new EditError('不能将表挂载为自身的子分区');
  if (!parent.partitionBy) throw new EditError(`表 ${parent.name} 不是分区父表`);
  if (child.partitionOf !== null) throw new EditError(`表 ${child.name} 已经是子分区`);
  const ancestors = ancestorsOf(m, parentId);
  if (ancestors.some((a) => a.id === childId)) throw new EditError('不能形成循环分区引用');

  const spec = resolvePartitionBy(m, parent);
  if (!spec) throw new EditError(`无法解析表 ${parent.name} 的分区定义`);
  const trimmed = bound.trim();
  const err = validatePartitionBound(spec.strategy, trimmed, spec.keys.length);
  if (err) throw new EditError(err);
  if (
    parsePartitionBound(trimmed)?.kind === 'default' &&
    partitionsOf(m, parentId).some((c) => parsePartitionBound(c.partitionOf!.bound)?.kind === 'default')
  ) {
    throw new EditError(`表 ${parent.name} 已有 DEFAULT 子分区`);
  }

  // 校验外部外键与序列归属
  if (all(m, 'foreignKey').some((fk) => fk.refTable === childId && fk.parent !== childId))
    throw new EditError(`表 ${child.name} 被其他表的外键引用，不能挂载为子分区`);
  const childCols = columnsOf(m, childId);
  const childColIds = new Set(childCols.map((c) => c.id));
  if (all(m, 'sequence').some((s) => s.ownedBy && childColIds.has(s.ownedBy)))
    throw new EditError(`表 ${child.name} 存在归属列的序列，请先解除序列归属后再挂载`);

  // 校验列与根父表一致
  const rootId = rootTableId(m, parentId);
  const rootCols = columnsOf(m, rootId);
  if (childCols.length !== rootCols.length)
    throw new EditError(
      `表 ${child.name} 的列数（${childCols.length}）与分区父表（${rootCols.length}）不一致`,
    );
  const colMap = new Map<string, string>();
  for (const rc of rootCols) {
    const cc = childCols.find((x) => x.name === rc.name);
    if (!cc) throw new EditError(`表 ${child.name} 缺少分区父表的列 ${rc.name}`);
    if (cc.identity)
      throw new EditError(`表 ${child.name} 的列 ${cc.name} 为 IDENTITY，不能直接挂载为子分区`);
    if (
      cc.type !== rc.type ||
      cc.typeRef !== rc.typeRef ||
      cc.collation !== rc.collation ||
      !deepEqual(cc.generated, rc.generated)
    ) {
      throw new EditError(`表 ${child.name} 的列 ${cc.name} 类型定义与分区父表不一致`);
    }
    if (cc.notNull !== rc.notNull) {
      throw new EditError(`表 ${child.name} 的列 ${cc.name} 非空属性与分区父表不一致`);
    }
    if (!deepEqual(cc.default, rc.default)) {
      throw new EditError(`表 ${child.name} 的列 ${cc.name} 默认值与分区父表不一致`);
    }
    colMap.set(cc.id, rc.id);
  }

  // 校验子表及其后代主键与父表/祖先主键不冲突
  const ancestorIds = new Set(ancestors.map((a) => a.id));
  const ancPks = all(m, 'primaryKey').filter((k) => ancestorIds.has(k.parent));
  const childPk = childrenOf(m, childId, 'primaryKey')[0];
  if (childPk && ancPks.length > 0) {
    const mapped = childPk.columns.map((c) => colMap.get(c) ?? c);
    if (!ancPks.some((pk) => deepEqual(pk.columns, mapped))) {
      throw new EditError(`表 ${child.name} 的主键与分区父表不一致`);
    }
  }
  if (ancPks.length > 0) {
    for (const desc of partitionDescendants(m, childId)) {
      if (childrenOf(m, desc.id, 'primaryKey').length > 0) {
        throw new EditError(`子表 ${desc.name} 已存在主键，与分区父表主键冲突`);
      }
    }
  }

  // 预计算将被父表吸收的重复约束/索引与跨层同名冲突校验（先于任何状态修改，保证失败时不留半残状态）
  const subtree = [child, ...partitionDescendants(m, childId)];
  const subtreeIds = new Set(subtree.map((s) => s.id));
  const mapCol = (c: string) => colMap.get(c) ?? c;

  const ancUniques = all(m, 'unique').filter((u) => ancestorIds.has(u.parent));
  const ancChecks = all(m, 'check').filter((k) => ancestorIds.has(k.parent));
  const ancFks = all(m, 'foreignKey').filter((f) => ancestorIds.has(f.parent));
  const ancIdxs = all(m, 'index').filter((x) => ancestorIds.has(x.parent));

  const ancPropagatedConNames = new Set<string>();
  for (const ak of ancChecks) ancPropagatedConNames.add(ak.name);
  for (const af of ancFks) ancPropagatedConNames.add(af.name);
  for (const rc of rootCols) {
    if (rc.notNull && rc.notNullName) ancPropagatedConNames.add(rc.notNullName);
  }

  const absorbedIds = new Set<string>();
  if (childPk && ancPks.length > 0) absorbedIds.add(childPk.id);
  for (const u of childrenOf(m, childId, 'unique')) {
    const mappedCols = u.columns.map(mapCol);
    if (
      ancUniques.some((au) => au.nullsNotDistinct === u.nullsNotDistinct && deepEqual(au.columns, mappedCols))
    ) {
      absorbedIds.add(u.id);
    }
  }
  for (const sub of subtree) {
    for (const ck of childrenOf(m, sub.id, 'check')) {
      if (!ck.noInherit && ancChecks.some((ak) => ak.name === ck.name && ak.expr === ck.expr)) {
        absorbedIds.add(ck.id);
      }
    }
  }
  for (const fk of childrenOf(m, childId, 'foreignKey')) {
    const mappedCols = fk.columns.map(mapCol);
    const mappedRefCols = subtreeIds.has(fk.refTable) ? fk.refColumns.map(mapCol) : fk.refColumns;
    if (
      ancFks.some(
        (af) =>
          deepEqual(af.columns, mappedCols) &&
          af.refTable === fk.refTable &&
          deepEqual(af.refColumns, mappedRefCols) &&
          af.onDelete === fk.onDelete &&
          af.onUpdate === fk.onUpdate &&
          af.match === fk.match &&
          af.deferrable === fk.deferrable &&
          af.initiallyDeferred === fk.initiallyDeferred,
      )
    ) {
      absorbedIds.add(fk.id);
    }
  }
  for (const idx of childrenOf(m, childId, 'index')) {
    const mappedEls = idx.elements.map((el) => ({ ...el, column: el.column ? mapCol(el.column) : null }));
    const mappedInc = idx.include.map(mapCol);
    if (
      ancIdxs.some(
        (ax) =>
          ax.unique === idx.unique &&
          ax.method === idx.method &&
          deepEqual(ax.elements, mappedEls) &&
          deepEqual(ax.include, mappedInc) &&
          ax.where === idx.where &&
          ax.nullsNotDistinct === idx.nullsNotDistinct,
      )
    ) {
      absorbedIds.add(idx.id);
    }
  }

  // 校验同名异义/NO INHERIT CHECK 约束及待挂载子树全部约束名不与祖先下传约束（CHECK / FK / 根列 NOT NULL）冲突
  for (const sub of subtree) {
    for (const ck of childrenOf(m, sub.id, 'check')) {
      if (absorbedIds.has(ck.id)) continue;
      if (ancChecks.some((ak) => ak.name === ck.name)) {
        throw new EditError(
          `表 ${sub.name} 的检查约束 ${ck.name} 与分区父表同名但表达式不同或设为 NO INHERIT，不能挂载`,
        );
      }
      if (ancPropagatedConNames.has(ck.name)) {
        throw new EditError(`表 ${sub.name} 的约束 ${ck.name} 与分区祖先表继承的约束同名冲突，不能挂载`);
      }
    }
    for (const k of [
      ...childrenOf(m, sub.id, 'primaryKey'),
      ...childrenOf(m, sub.id, 'unique'),
      ...childrenOf(m, sub.id, 'foreignKey'),
    ]) {
      if (absorbedIds.has(k.id)) continue;
      if (ancPropagatedConNames.has(k.name)) {
        throw new EditError(`表 ${sub.name} 的约束 ${k.name} 与分区祖先表继承的约束同名冲突，不能挂载`);
      }
    }
  }

  // 多级分区：若待挂载表自身也是分区表，祖先的全部唯一约束/主键/唯一索引必须兼容下级分区键
  if (child.partitionBy !== null) {
    const childReq = requiredUniquePartitionKeys(m, childId);
    const mappedChildCols = childReq.directCols.map((c) => colMap.get(c) ?? c);
    for (const anc of ancestors) {
      const ancReq = requiredUniquePartitionKeys(m, anc.id);
      const combined = {
        hasExprKey: ancReq.hasExprKey || childReq.hasExprKey,
        directCols: [...new Set([...ancReq.directCols, ...mappedChildCols])],
      };
      for (const pk of childrenOf(m, anc.id, 'primaryKey'))
        assertPartitionConstraintCompat(combined, 'primaryKey', pk.columns);
      for (const u of childrenOf(m, anc.id, 'unique'))
        assertPartitionConstraintCompat(combined, 'unique', u.columns);
      for (const x of childrenOf(m, anc.id, 'index'))
        if (x.unique) assertPartitionConstraintCompat(combined, 'index', [], x.elements);
    }
  }

  // 映射子表及其后代上的列引用
  remapColRefsOnTable(m, childId, colMap);
  for (const o of all(m, 'opaque')) {
    if (o.deps.some((d) => colMap.has(d))) {
      o.deps = [...new Set(o.deps.map((d) => colMap.get(d) ?? d))];
    }
  }

  // 移除将被父表吸收的重复约束/索引
  for (const id of absorbedIds) delete m.objects[id];

  // 删除子表自有列对象，改为继承父表列定义
  for (const cc of childCols) delete m.objects[cc.id];
  child.partitionOf = { parent: parentId, bound: trimmed };
};

export const detachPartition = (m: Model, childId: string) => {
  if (!getDialect(m.dialect).capabilities.partitioning) throw new EditError('当前方言不支持分区表');
  const child = get(m, childId, 'table');
  normalizePartitionFamily(m, childId);
  if (!child.partitionOf) throw new EditError(`表 ${child.name} 不是分区子表`);
  const parentId = child.partitionOf.parent;
  const ancestors = ancestorsOf(m, parentId);
  const rootId = rootTableId(m, childId);
  const rootCols = columnsOf(m, rootId);

  child.partitionOf = null;

  // 物化根父表的列到脱离后的独立表（使用确定性 ID 保证协作同步一致）
  const colMap = new Map<string, string>();
  for (const rc of rootCols) {
    const cid = nextDetId(m, `${childId}:col:${rc.id}`);
    colMap.set(rc.id, cid);
    const col: Column = {
      id: cid,
      kind: 'column',
      parent: childId,
      name: rc.name,
      pos: rc.pos,
      type: rc.type,
      typeRef: rc.typeRef,
      notNull: rc.notNull,
      notNullName: null,
      notNullNameMode: 'derived',
      default: rc.default ? clonePlain(rc.default) : null,
      identity: null, // PG 子分区不继承 attidentity
      generated: rc.generated ? clonePlain(rc.generated) : null,
      collation: rc.collation,
      comment: null,
    };
    m.objects[cid] = col;
  }

  // 先将子表已有本地约束/索引、后代分区键及直接依赖子分区的不透明对象（含 schema 级视图）列引用映射到新物化的列 ID
  remapColRefsOnTable(m, childId, colMap);
  const childTree = new Set([childId, ...partitionDescendants(m, childId).map((d) => d.id)]);
  // child.partitionOf 已置空，rootId 及其剩余后代覆盖全部祖先与兄弟分区表，防止共享视图丢失根列依赖
  const ancTree = new Set([rootId, ...partitionDescendants(m, rootId).map((d) => d.id)]);
  for (const o of all(m, 'opaque')) {
    const touchesChild = childTree.has(o.parent) || o.deps.some((d) => childTree.has(d));
    if (!touchesChild || !o.deps.some((d) => colMap.has(d))) continue;
    const touchesAnc = ancTree.has(o.parent) || o.deps.some((d) => ancTree.has(d));
    if (touchesAnc) {
      const extra = o.deps.filter((d) => colMap.has(d)).map((d) => colMap.get(d)!);
      o.deps = [...new Set([...o.deps, ...extra])];
    } else {
      o.deps = [...new Set(o.deps.map((d) => colMap.get(d) ?? d))];
    }
  }

  // 物化父表/祖先表上由 PG DETACH 自动转正为独立对象的约束与索引
  const mapCol = (c: string) => colMap.get(c) ?? c;
  for (const anc of ancestors) {
    for (const pk of childrenOf(m, anc.id, 'primaryKey')) {
      if (childrenOf(m, childId, 'primaryKey').length > 0) continue;
      const pid = nextDetId(m, `${childId}:con:${pk.id}`);
      m.objects[pid] = {
        id: pid,
        kind: 'primaryKey',
        parent: childId,
        name: '',
        nameMode: 'derived',
        columns: pk.columns.map(mapCol),
        comment: null,
      };
    }
    for (const u of childrenOf(m, anc.id, 'unique')) {
      const uid = nextDetId(m, `${childId}:con:${u.id}`);
      m.objects[uid] = {
        id: uid,
        kind: 'unique',
        parent: childId,
        name: '',
        nameMode: 'derived',
        columns: u.columns.map(mapCol),
        nullsNotDistinct: u.nullsNotDistinct,
        comment: null,
      };
    }
    for (const ck of childrenOf(m, anc.id, 'check')) {
      if (childrenOf(m, childId, 'check').some((x) => x.name === ck.name)) continue;
      const cid = nextDetId(m, `${childId}:con:${ck.id}`);
      m.objects[cid] = {
        id: cid,
        kind: 'check',
        parent: childId,
        name: ck.name,
        nameMode: 'explicit',
        expr: ck.expr,
        noInherit: false,
        comment: null,
      };
    }
    for (const fk of childrenOf(m, anc.id, 'foreignKey')) {
      if (childrenOf(m, childId, 'foreignKey').some((x) => x.name === fk.name)) continue;
      const fid = nextDetId(m, `${childId}:con:${fk.id}`);
      m.objects[fid] = {
        id: fid,
        kind: 'foreignKey',
        parent: childId,
        name: fk.name,
        nameMode: 'explicit',
        columns: fk.columns.map(mapCol),
        refTable: fk.refTable,
        refColumns: [...fk.refColumns],
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
        match: fk.match,
        deferrable: fk.deferrable,
        initiallyDeferred: fk.initiallyDeferred,
        comment: null,
      };
    }
    for (const idx of childrenOf(m, anc.id, 'index')) {
      const iid = nextDetId(m, `${childId}:idx:${idx.id}`);
      m.objects[iid] = {
        id: iid,
        kind: 'index',
        parent: childId,
        name: '',
        nameMode: 'derived',
        unique: idx.unique,
        method: idx.method,
        elements: idx.elements.map((e) => ({ ...e, column: e.column ? mapCol(e.column) : null })),
        include: idx.include.map(mapCol),
        where: idx.where,
        nullsNotDistinct: idx.nullsNotDistinct,
        comment: null,
      };
    }
  }

  refreshDerivedNames(m, childId);
};

// ───── 列 ─────

export interface ColumnSpec {
  name: string;
  type: string;
  typeRef?: string | null;
  notNull?: boolean;
  default?: ColumnDefault | null;
  /** options：粘贴时带上来源列的序列参数（缺省项取默认值，type 缺省按列类型推导） */
  identity?: { always: boolean; options?: Partial<SequenceOptions> } | null;
  generated?: { expr: string; stored: boolean } | null;
  collation?: string | null;
  /** 放在这一列之前；不传则放在最后 */
  before?: string;
  /** 指定 ID（同步层要求客户端和服务器执行同一修改时生成相同的 ID） */
  id?: string;
  /** 方言专属列扩展 */
  ext?: ColumnExt;
}

/**
 * 普通列类型的规范写法（各方言 normalizeType，与界面输入类型时的规范化一致），让模型与引擎读回的写法可以直接比较（#132）。
 * SQLite 始终走 sqliteNormalizeType（纯空白同样归为 ''）；其他方言中枚举列（有 typeRef）与空类型原样保留。
 */
const canonicalColumnType = (m: Model, type: string, typeRef: string | null | undefined): string => {
  if (typeRef) return type;
  if (m.dialect === 'sqlite') return sqliteNormalizeType(type);
  return !type.trim() ? type : getDialect(m.dialect).normalizeType(type);
};

/** 排序规则的规范写法：目前只有 SQLite 内置排序规则（大写），其他方言的排序规则名依赖目标库目录，原样保留 */
const canonicalCollation = (m: Model, collation: string | null): string | null =>
  m.dialect === 'sqlite' ? sqliteNormalizeCollation(collation) : collation;

const PG_SEQ_TYPE_LIMITS: Readonly<Record<PgSerialBase, readonly [bigint, bigint]>> = {
  smallint: [-32768n, 32767n],
  integer: [-2147483648n, 2147483647n],
  bigint: [-9223372036854775808n, 9223372036854775807n],
};

const parseBigInt = (s: string | null): bigint | null => {
  if (s === null) return null;
  try {
    return BigInt(s.trim());
  } catch {
    return null;
  }
};

const clampSeqOptionsForType = (
  opts: SequenceOptions,
  base: PgSerialBase,
): { min: string | null; max: string | null; start: string | null } => {
  const [typeMin, typeMax] = PG_SEQ_TYPE_LIMITS[base];
  const minVal = parseBigInt(opts.min);
  const nextMin = minVal !== null && minVal >= typeMin && minVal <= typeMax ? opts.min : null;
  const maxVal = parseBigInt(opts.max);
  const nextMax = maxVal !== null && maxVal >= typeMin && maxVal <= typeMax ? opts.max : null;

  const inc = parseBigInt(opts.increment);
  const asc = inc === null ? !opts.increment.trim().startsWith('-') : inc >= 0n;
  const effectiveMin = nextMin !== null ? parseBigInt(nextMin)! : asc ? 1n : typeMin;
  const effectiveMax = nextMax !== null ? parseBigInt(nextMax)! : asc ? typeMax : -1n;

  const startVal = parseBigInt(opts.start);
  const nextStart =
    startVal !== null &&
    startVal >= typeMin &&
    startVal <= typeMax &&
    startVal >= effectiveMin &&
    startVal <= effectiveMax
      ? opts.start
      : null;

  return { min: nextMin, max: nextMax, start: nextStart };
};

const makeDerivedSerialSequence = (
  m: Model,
  schemaId: string,
  colId: string,
  base: PgSerialBase,
): Sequence => {
  let seqId = nextDetId(m, `${colId}:serial-seq`);
  if (seqId === colId) {
    for (let i = 1; ; i++) {
      const candidate = derivedUuid(`${colId}:serial-seq#${i}`);
      if (candidate !== colId && !Object.hasOwn(m.objects, candidate)) {
        seqId = candidate;
        break;
      }
    }
  }
  return {
    id: seqId,
    kind: 'sequence',
    parent: schemaId,
    name: '',
    nameMode: 'derived',
    ownedBy: colId,
    options: {
      type: base,
      increment: '1',
      min: null,
      max: null,
      start: null,
      cache: '1',
      cycle: false,
    },
    comment: null,
  };
};

export const addColumn = (m: Model, table: string, spec: ColumnSpec): string => {
  const t = get(m, table, 'table');
  const d = getDialect(m.dialect);
  const type = canonicalColumnType(m, spec.type, spec.typeRef);
  assertIdent(m, spec.name, 'column');
  normalizePartitionFamily(m, table);
  assertNotPartitionChild(m, table);
  if (spec.identity && !d.capabilities.sequences) {
    throw new EditError('当前方言不支持 PG IDENTITY');
  }
  if (spec.typeRef && !d.capabilities.enums) {
    throw new EditError('当前方言不支持独立枚举类型');
  }
  const cols = columnsOf(m, table);
  const dup =
    m.dialect === 'sqlite' || m.dialect === 'mysql' || m.dialect === 'mssql'
      ? cols.some((c) => c.name.toLowerCase() === spec.name.toLowerCase())
      : cols.some((c) => c.name === spec.name);
  if (dup) throw new EditError(`列 ${spec.name} 已存在`);
  if (m.dialect === 'mysql') {
    assertMysqlSafeOption(spec.ext?.mysql?.charset, '字符集名');
    assertMysqlSafeOption(spec.collation, '排序规则名');
  }
  if (m.dialect === 'sqlite' && t.ext?.sqlite?.strict) {
    if (!type) {
      throw new EditError('STRICT 表的列必须声明类型（仅允许 INT/INTEGER/REAL/TEXT/BLOB/ANY）');
    }
    if (!SQLITE_STRICT_TYPES.has(type)) {
      throw new EditError(`STRICT 表不支持列类型 ${spec.type}（仅允许 INT/INTEGER/REAL/TEXT/BLOB/ANY）`);
    }
  }
  const serialKind = m.dialect === 'pg' && !spec.typeRef ? parsePgSerialType(spec.type) : null;
  if (m.dialect === 'pg' && !spec.typeRef) {
    if (isPgSerialArrayType(spec.type)) throw new EditError('serial 不能用作数组类型');
    if (serialKind) {
      if (spec.identity) throw new EditError('IDENTITY 列不能同时是 serial');
      if (spec.generated) throw new EditError('生成列不能改成 serial');
      if (spec.default != null) throw new EditError('列已有默认值，不能改成 serial，请先清空默认值');
    }
  }
  let pos: string;
  if (spec.before) {
    const i = cols.findIndex((c) => c.id === spec.before);
    if (i < 0) throw new EditError(`列 ${spec.before} 不属于表 ${t.name}`);
    pos = generateKeyBetween(cols[i - 1]?.pos ?? null, cols[i]!.pos);
  } else pos = generateKeyBetween(cols.at(-1)?.pos ?? null, null);
  const colId = spec.id ?? newId();
  const serialSeq = serialKind
    ? makeDerivedSerialSequence(m, t.parent, colId, PG_SERIAL_BASE[serialKind])
    : null;
  // ext.mssql.inferredNotNull 是影子库规范化写回的派生字段（ADR 0019）：新列一律不带，由下一次规范化算出
  const cleanedExt = cleanExt(stripMssqlInferredNotNull(spec.ext));
  const c: Column = {
    id: colId,
    kind: 'column',
    parent: table,
    name: spec.name,
    pos,
    type: serialKind ? PG_SERIAL_BASE[serialKind] : type,
    typeRef: serialKind ? null : (spec.typeRef ?? null),
    notNull: !!(spec.notNull || spec.identity || serialKind),
    notNullName: null,
    notNullNameMode: 'derived',
    default: serialSeq
      ? { nextval: serialSeq.id }
      : spec.identity || spec.generated
        ? null
        : (spec.default ?? null),
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
    collation: canonicalCollation(m, spec.collation ?? null),
    comment: null,
    ...(cleanedExt ? { ext: cleanedExt as ColumnExt } : {}),
  };
  if (c.identity) {
    c.identity.options.type = identityType(c.type);
    const opts = spec.identity?.options;
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (v !== undefined) (c.identity.options as Record<string, unknown>)[k] = v;
      }
    }
  }
  m.objects[c.id] = c;
  if (serialSeq) m.objects[serialSeq.id] = serialSeq;
  refreshDerivedNames(m, t.id);
  return c.id;
};

/** 更新列的方言专属扩展选项（如 SQLite AUTOINCREMENT、MySQL UNSIGNED/AUTO_INCREMENT） */
export const setColumnExt = (m: Model, id: string, ext: ColumnExt | null) => {
  const c = get(m, id, 'column');
  assertNotPartitionChild(m, c.parent);
  if (m.dialect === 'sqlite' && ext?.sqlite?.autoincrement) {
    const t = get(m, c.parent, 'table');
    if (t.ext?.sqlite?.withoutRowid) {
      throw new EditError('WITHOUT ROWID 表不能使用 AUTOINCREMENT');
    }
    if (c.type.trim().toUpperCase() !== 'INTEGER') {
      throw new EditError('AUTOINCREMENT 只能用于 INTEGER 类型列');
    }
    const pk = childrenOf(m, c.parent, 'primaryKey')[0];
    if (!pk || pk.columns.length !== 1 || pk.columns[0] !== c.id) {
      throw new EditError('AUTOINCREMENT 只能用于单列主键');
    }
  }
  if (m.dialect === 'mysql' && ext?.mysql) {
    assertMysqlSafeOption(ext.mysql.charset, '字符集名');
  }
  // ext.mssql.inferredNotNull 是派生字段（ADR 0019）：忽略调用方传入的值，整体替换 ext 时保留当前值
  const inferred = c.ext?.mssql?.inferredNotNull === true;
  const cleaned = cleanExt(stripMssqlInferredNotNull(ext ?? undefined));
  if (cleaned) c.ext = cleaned as ColumnExt;
  else delete c.ext;
  if (inferred) setMssqlInferredNotNull(c, true);
  // MSSQL 带默认值的列：整体替换 ext 后重新推导默认约束名 DF_<table>_<col>（否则推导名会随 ext 一起丢失）
  if (m.dialect === 'mssql') refreshDerivedNames(m, c.parent);
};

const identityType = (type: string): SequenceOptions['type'] =>
  type === 'smallint' ? 'smallint' : type === 'integer' ? 'integer' : 'bigint';

export const renameColumn = (m: Model, id: string, name: string) => {
  const c = get(m, id, 'column');
  const d = getDialect(m.dialect);
  assertIdent(m, name, 'column');
  assertNotPartitionChild(m, c.parent);
  normalizePartitionFamily(m, c.parent);
  const dup =
    m.dialect === 'sqlite' || m.dialect === 'mysql' || m.dialect === 'mssql'
      ? columnsOf(m, c.parent).some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())
      : columnsOf(m, c.parent).some((x) => x.name === name && x.id !== id);
  if (dup) throw new EditError(`列 ${name} 已存在`);
  const old = c.name;
  c.name = name;
  // 同表及所有后代子分区表达式里对这一列的引用一起改写
  const affected = [c.parent, ...partitionDescendants(m, c.parent).map((d) => d.id)];
  for (const tid of affected) {
    const table = get(m, tid, 'table');
    if (table.partitionBy && typeof table.partitionBy !== 'string') {
      for (const k of table.partitionBy.keys) if (k.expr) k.expr = d.renameInExpr(k.expr, old, name);
    }
    for (const o of allChildrenOf(m, tid)) {
      if (o.kind === 'check') o.expr = d.renameInExpr(o.expr, old, name);
      if (o.kind === 'index') {
        for (const e of o.elements) if (e.expr) e.expr = d.renameInExpr(e.expr, old, name);
        if (o.where) o.where = d.renameInExpr(o.where, old, name);
      }
      if (o.kind === 'column') {
        if (o.generated) o.generated.expr = d.renameInExpr(o.generated.expr, old, name);
        if (o.default && 'expr' in o.default) o.default.expr = d.renameInExpr(o.default.expr, old, name);
      }
    }
  }
  for (const tid of affected) refreshDerivedNames(m, tid);
};

/** 删列：依赖它的约束、索引、外键、生成列、属于它的序列一并删除 */
export const dropColumn = (m: Model, id: string) => {
  const c = get(m, id, 'column');
  const d = getDialect(m.dialect);
  assertNotPartitionChild(m, c.parent);
  normalizePartitionFamily(m, c.parent);
  assertNotPartitionKeyCol(m, id, '删除');
  if (m.dialect === 'sqlite' || m.dialect === 'mysql') {
    const tableCols = columnsOf(m, c.parent);
    const willDrop = new Set<string>([id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const col of tableCols) {
        if (willDrop.has(col.id) || !col.generated) continue;
        const droppedNames = [...willDrop].map((cid) => get(m, cid, 'column').name);
        if (droppedNames.some((n) => d.exprReferences(col.generated!.expr, n))) {
          willDrop.add(col.id);
          changed = true;
        }
      }
    }
    if (tableCols.length - willDrop.size <= 0) {
      throw new EditError(
        `${m.dialect === 'mysql' ? 'MySQL' : 'SQLite'} 表至少需要保留一列，无法删除最后一列`,
      );
    }
  }
  const affected = [c.parent, ...partitionDescendants(m, c.parent).map((x) => x.id)];
  for (const o of all(m, 'primaryKey')) {
    if (o.columns.includes(id)) delete m.objects[o.id];
  }
  for (const o of all(m, 'unique')) {
    if (o.columns.includes(id)) delete m.objects[o.id];
  }
  for (const o of all(m, 'foreignKey')) {
    if (o.columns.includes(id) || o.refColumns.includes(id)) delete m.objects[o.id];
  }
  for (const s of all(m, 'sequence')) {
    if (s.ownedBy === id) delete m.objects[s.id];
  }
  for (const tid of affected) {
    for (const o of allChildrenOf(m, tid)) {
      if (o.kind === 'check' && d.exprReferences(o.expr, c.name)) {
        delete m.objects[o.id];
      } else if (
        o.kind === 'index' &&
        (o.elements.some((e) => e.column === id || (e.expr && d.exprReferences(e.expr, c.name))) ||
          o.include.includes(id) ||
          (!!o.where && d.exprReferences(o.where, c.name)))
      ) {
        delete m.objects[o.id];
      } else if (
        o.kind === 'column' &&
        o.id !== id &&
        o.parent === c.parent &&
        !!o.generated &&
        d.exprReferences(o.generated.expr, c.name)
      ) {
        dropColumn(m, o.id);
      }
    }
  }
  dropDependentOpaques(m, new Set([id]));
  delete m.objects[id];
};

export const setColumnType = (m: Model, id: string, rawType: string, typeRef: string | null = null) => {
  const c = get(m, id, 'column');
  const type = canonicalColumnType(m, rawType, typeRef);
  assertNotPartitionChild(m, c.parent);
  normalizePartitionFamily(m, c.parent);
  assertNotPartitionKeyCol(m, id, '修改类型');
  if (typeRef) {
    if (!getDialect(m.dialect).capabilities.enums) throw new EditError('当前方言不支持独立枚举类型');
    get(m, typeRef, 'enum');
  }
  if (m.dialect === 'pg' && !typeRef) {
    if (isPgSerialArrayType(rawType)) throw new EditError('serial 不能用作数组类型');
    const serialKind = parsePgSerialType(rawType);
    if (serialKind) {
      if (c.generated) throw new EditError('生成列不能改成 serial');
      if (c.identity) throw new EditError('IDENTITY 列不能改成 serial，请先取消自增（IDENTITY）');
      let seq: Sequence | null = null;
      if (c.default !== null) {
        if ('nextval' in c.default) {
          const existing = find(m, c.default.nextval);
          if (existing?.kind === 'sequence' && existing.ownedBy === c.id) seq = existing;
        }
        if (!seq) throw new EditError('列已有默认值，不能改成 serial，请先清空默认值');
      } else {
        const activeIdx = getActiveModelIndex(m);
        const owned = activeIdx
          ? activeIdx.sequencesOwnedBy(c.id)
          : all(m, 'sequence').filter((s) => s.ownedBy === c.id);
        if (owned.length > 0) {
          owned.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          seq = owned[0]!;
        }
      }
      const base = PG_SERIAL_BASE[serialKind];
      if (seq) {
        const clamped = clampSeqOptionsForType(seq.options, base);
        const needsColUpdate =
          c.type !== base ||
          c.typeRef !== null ||
          !c.notNull ||
          !c.default ||
          !('nextval' in c.default) ||
          c.default.nextval !== seq.id;
        const needsSeqUpdate =
          seq.options.type !== base ||
          seq.options.min !== clamped.min ||
          seq.options.max !== clamped.max ||
          seq.options.start !== clamped.start;
        if (!needsColUpdate && !needsSeqUpdate) return;
        c.type = base;
        c.typeRef = null;
        c.default = { nextval: seq.id };
        if (!c.notNull) {
          c.notNull = true;
          c.notNullName = null;
          c.notNullNameMode = 'derived';
        }
        seq.options.type = base;
        seq.options.min = clamped.min;
        seq.options.max = clamped.max;
        seq.options.start = clamped.start;
        refreshDerivedNames(m, c.parent);
        return;
      }
      const t = get(m, c.parent, 'table');
      const newSeq = makeDerivedSerialSequence(m, t.parent, c.id, base);
      m.objects[newSeq.id] = newSeq;
      c.type = base;
      c.typeRef = null;
      c.default = { nextval: newSeq.id };
      if (!c.notNull) {
        c.notNull = true;
        c.notNullName = null;
        c.notNullNameMode = 'derived';
      }
      refreshDerivedNames(m, c.parent);
      return;
    }
  }
  if (m.dialect === 'sqlite') {
    const t = get(m, c.parent, 'table');
    if (t.ext?.sqlite?.strict) {
      if (!type) {
        throw new EditError('STRICT 表的列必须声明类型（仅允许 INT/INTEGER/REAL/TEXT/BLOB/ANY）');
      }
      if (!SQLITE_STRICT_TYPES.has(type)) {
        throw new EditError(`STRICT 表不支持列类型 ${rawType}（仅允许 INT/INTEGER/REAL/TEXT/BLOB/ANY）`);
      }
    }
    if (c.ext?.sqlite?.autoincrement && type !== 'INTEGER') {
      clearSqliteAutoincrement(c);
    }
  }
  c.type = type;
  c.typeRef = typeRef;
  if (c.identity) c.identity.options.type = identityType(type);
};

export const setNotNull = (m: Model, id: string, notNull: boolean) => {
  const c = get(m, id, 'column');
  assertNotPartitionChild(m, c.parent);
  normalizePartitionFamily(m, c.parent);
  if (!notNull) {
    if (c.identity) throw new EditError('identity 列必须 NOT NULL');
    // SQL Server 持久化计算列去掉显式 NOT NULL 后若仍由引擎推断为非空，主键照样成立（ADR 0019）
    if (
      all(m, 'primaryKey').some((k) => k.columns.includes(id)) &&
      !effectiveNotNull(m.dialect, { ...c, notNull: false })
    )
      throw new EditError('主键列必须 NOT NULL');
  }
  c.notNull = notNull;
  c.notNullName = null;
  c.notNullNameMode = 'derived';
  refreshDerivedNames(m, c.parent);
};

export const setDefault = (m: Model, id: string, def: ColumnDefault | null) => {
  const c = get(m, id, 'column');
  assertNotPartitionChild(m, c.parent);
  normalizePartitionFamily(m, c.parent);
  if (def && (c.identity || c.generated)) throw new EditError('identity 列和生成列不能有默认值');
  if (def && 'nextval' in def) get(m, def.nextval, 'sequence');
  c.default = def;
  refreshDerivedNames(m, c.parent);
};

export const setIdentity = (m: Model, id: string, identity: { always: boolean } | null) => {
  if (identity && !getDialect(m.dialect).capabilities.sequences) {
    throw new EditError('当前方言不支持 PG IDENTITY');
  }
  const c = get(m, id, 'column');
  assertNotPartitionChild(m, c.parent);
  normalizePartitionFamily(m, c.parent);
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
  assertNotPartitionChild(m, c.parent);
  normalizePartitionFamily(m, c.parent);
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
  const root = rootTableId(m, table);
  for (const c of cols) {
    const col = get(m, c, 'column');
    if (col.parent !== table && col.parent !== root) throw new EditError('列不属于这张表');
  }
};

export const addPrimaryKey = (
  m: Model,
  table: string,
  columns: string[],
  id = newId(),
  ext?: PrimaryKeyExt,
): string => {
  const t = get(m, table, 'table');
  normalizePartitionFamily(m, table);
  checkCols(m, table, columns);
  if (t.partitionBy !== null)
    assertPartitionConstraintCompat(requiredUniquePartitionKeys(m, table), 'primaryKey', columns);
  if (childrenOf(m, table, 'primaryKey').length) throw new EditError('表已有主键');
  for (const anc of ancestorsOf(m, table)) {
    if (anc.id !== table && childrenOf(m, anc.id, 'primaryKey').length) {
      throw new EditError(`分区父表 ${anc.name} 已有主键，子分区不能再添加主键`);
    }
  }
  for (const desc of partitionDescendants(m, table)) {
    if (childrenOf(m, desc.id, 'primaryKey').length) {
      throw new EditError(`子分区 ${desc.name} 已有主键，分区父表不能再添加主键`);
    }
  }
  for (const c of columns) {
    const col = get(m, c, 'column');
    if (!col.notNull) {
      col.notNull = true;
      col.notNullNameMode = 'derived';
    }
  }
  if (m.dialect === 'sqlite') {
    for (const col of columnsOf(m, table)) {
      if (
        col.ext?.sqlite?.autoincrement &&
        (columns.length !== 1 ||
          columns[0] !== col.id ||
          col.type.trim().toUpperCase() !== 'INTEGER' ||
          t.ext?.sqlite?.withoutRowid)
      ) {
        clearSqliteAutoincrement(col);
      }
    }
  }
  const cleanedExt = cleanExt(ext);
  const o: PrimaryKey = {
    ...keyBase(table, id),
    kind: 'primaryKey',
    columns,
    ...(cleanedExt ? { ext: cleanedExt as PrimaryKeyExt } : {}),
  };
  m.objects[o.id] = o;
  refreshDerivedNames(m, table);
  if (t.partitionOf) refreshDerivedNames(m, rootTableId(m, table));
  return o.id;
};

/**
 * 原子替换或清空表的主键：
 * - `columns` 为空时等价于删除主键（保留 WITHOUT ROWID 保护）；
 * - `columns` 非空且表已有主键时原地更新主键列（不经过无主键中间态，兼容 WITHOUT ROWID 表），
 *   并按需清理不再满足条件的 SQLite AUTOINCREMENT 标记及指向旧主键列的外部外键。
 */
export const setPrimaryKey = (
  m: Model,
  table: string,
  columns: string[],
  id = newId(),
  ext?: PrimaryKeyExt,
): string | null => {
  const existing = childrenOf(m, table, 'primaryKey')[0];
  if (columns.length === 0) {
    if (existing) dropKey(m, existing.id);
    return null;
  }
  if (!existing) return addPrimaryKey(m, table, columns, id, ext);

  const t = get(m, table, 'table');
  normalizePartitionFamily(m, table);
  checkCols(m, table, columns);
  if (t.partitionBy !== null)
    assertPartitionConstraintCompat(requiredUniquePartitionKeys(m, table), 'primaryKey', columns);
  for (const c of columns) {
    const col = get(m, c, 'column');
    if (!col.notNull) {
      col.notNull = true;
      col.notNullNameMode = 'derived';
    }
  }
  if (m.dialect === 'sqlite') {
    for (const col of columnsOf(m, table)) {
      if (
        col.ext?.sqlite?.autoincrement &&
        (columns.length !== 1 ||
          columns[0] !== col.id ||
          col.type.trim().toUpperCase() !== 'INTEGER' ||
          t.ext?.sqlite?.withoutRowid)
      ) {
        clearSqliteAutoincrement(col);
      }
    }
  }
  const oldSet = [...existing.columns].sort().join();
  const newSet = [...columns].sort().join();
  if (oldSet !== newSet) {
    const stillUnique =
      childrenOf(m, table, 'unique').some((u) => [...u.columns].sort().join() === oldSet) ||
      childrenOf(m, table, 'index').some(
        (ix) =>
          ix.unique &&
          !ix.where &&
          ix.elements.every((e) => e.column) &&
          ix.elements
            .map((e) => e.column!)
            .sort()
            .join() === oldSet,
      );
    if (!stillUnique) {
      for (const fk of all(m, 'foreignKey')) {
        if (fk.refTable === table && [...fk.refColumns].sort().join() === oldSet) delete m.objects[fk.id];
      }
    }
  }
  existing.columns = [...columns];
  if (ext !== undefined) {
    const cleanedExt = cleanExt(ext);
    if (cleanedExt) existing.ext = cleanedExt as PrimaryKeyExt;
    else delete existing.ext;
  }
  refreshDerivedNames(m, table);
  if (t.partitionOf) refreshDerivedNames(m, rootTableId(m, table));
  return existing.id;
};

export const addUnique = (
  m: Model,
  table: string,
  columns: string[],
  nullsNotDistinct = false,
  id = newId(),
  ext?: UniqueExt,
): string => {
  if (nullsNotDistinct && !getDialect(m.dialect).capabilities.nullsNotDistinct) {
    throw new EditError('当前方言不支持 NULLS NOT DISTINCT');
  }
  const t = get(m, table, 'table');
  normalizePartitionFamily(m, table);
  checkCols(m, table, columns);
  if (t.partitionBy !== null)
    assertPartitionConstraintCompat(requiredUniquePartitionKeys(m, table), 'unique', columns);
  const cleanedExt = cleanExt(ext);
  const o: Unique = {
    ...keyBase(table, id),
    kind: 'unique',
    columns,
    nullsNotDistinct,
    ...(cleanedExt ? { ext: cleanedExt as UniqueExt } : {}),
  };
  m.objects[o.id] = o;
  refreshDerivedNames(m, table);
  return o.id;
};

export const addCheck = (m: Model, table: string, expr: string, id = newId(), noInherit = false): string => {
  const t = get(m, table, 'table');
  normalizePartitionFamily(m, table);
  if (noInherit && t.partitionBy !== null) throw new EditError('分区父表的 CHECK 约束不能设为 NO INHERIT');
  checkExprColumns(m, table, expr);
  const o: Check = { ...keyBase(table, id), kind: 'check', expr, noInherit };
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
  normalizePartitionFamily(m, table);
  normalizePartitionFamily(m, refTable);
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
  opts: Partial<Pick<Index, 'unique' | 'method' | 'include' | 'where' | 'nullsNotDistinct' | 'ext'>> = {},
  id = newId(),
): string => {
  if (opts.nullsNotDistinct && !getDialect(m.dialect).capabilities.nullsNotDistinct) {
    throw new EditError('当前方言不支持 NULLS NOT DISTINCT');
  }
  if (elements.length === 0) throw new EditError('索引至少需要一个元素');
  if (!elements.every(isValidIndexElement)) throw new EditError('索引元素必须是列或非空表达式之一');
  const t = get(m, table, 'table');
  normalizePartitionFamily(m, table);
  const fullElements: IndexElement[] = elements.map((e) => ({
    column: null,
    expr: null,
    desc: false,
    nullsFirst: null,
    opclass: null,
    collation: null,
    ...e,
  }));
  for (const e of fullElements) e.collation = canonicalCollation(m, e.collation);
  const elCols = fullElements.flatMap((e) => (e.column ? [e.column] : []));
  if (elCols.length) checkCols(m, table, elCols);
  if (opts.include?.length) checkCols(m, table, opts.include);
  for (const e of fullElements) if (e.expr) checkExprColumns(m, table, e.expr);
  if (opts.where) checkExprColumns(m, table, opts.where);
  if (opts.unique && t.partitionBy !== null) {
    assertPartitionConstraintCompat(requiredUniquePartitionKeys(m, table), 'index', [], fullElements);
  }
  const { ext, ...restOpts } = opts;
  const cleanedExt = cleanExt(ext);
  const o: Index = {
    ...keyBase(table, id),
    kind: 'index',
    unique: false,
    method: 'btree',
    include: [],
    where: null,
    nullsNotDistinct: false,
    ...restOpts,
    elements: fullElements,
    ...(cleanedExt ? { ext: cleanedExt as IndexExt } : {}),
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
  normalizePartitionFamily(m, o.parent);
  if (o.kind === 'primaryKey' && m.dialect === 'sqlite') {
    const t = get(m, o.parent, 'table');
    if (t.ext?.sqlite?.withoutRowid) {
      throw new EditError('WITHOUT ROWID 表不能删除主键，请先关闭 WITHOUT ROWID');
    }
    for (const cid of o.columns) {
      const col = find(m, cid);
      if (col?.kind === 'column' && col.ext?.sqlite?.autoincrement) clearSqliteAutoincrement(col);
    }
  }
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
  normalizePartitionFamily(m, o.parent);
  assertIdent(m, name, o.kind === 'index' ? 'index' : 'constraint');
  const rel = m.dialect === 'sqlite' ? o.kind === 'index' : o.kind !== 'check' && o.kind !== 'foreignKey';
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
    normalizePartitionFamily(m, o.parent);
    o.nameMode = 'derived';
    o.name = ''; // 清空当前名字，按推导规则重新取最小空位（稳定推导名只在输入变化或显式重置时重算）
    refreshDerivedNames(m, o.parent);
  }
};

export const setComment = (m: Model, id: string, comment: string | null) => {
  get(m, id).comment = comment;
};

export const findTable = (m: Model, schema: string, name: string): Table | undefined =>
  all(m, 'table').find((t) => t.name === name && find(m, t.parent)?.name === schema);
