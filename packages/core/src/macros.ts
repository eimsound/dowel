// MCP 编译型复合宏（ADR 0015 第 2 节）：`defineTable` / `alterColumn` 只存在于 MCP 输入编译层，
// 由服务端在预演阶段展开为标准底层 mutator；绝不进入同步层 `mutators` 注册表、`room_commits` 或历史回放
// （落库的仍然全是原语组成的 `batch`）。
//
// 编译模型：惰性生成器。`compileMacro` 先做参数与互斥校验、分配本宏新建对象的 ID，然后返回一个生成器；
// 调用方每执行完一步就把最新的模型经 `next(model)` 传回，生成器据此决定下一步（读取最新状态、值已一致则跳过），
// 全程不额外复制模型。
//
// 严格对象 ID 底线：编辑目标（alterColumn.id）只认已有对象 ID 或同批前序 `$ref:<alias>`，绝不按名字猜测。
// 允许按名称 / 限定名解析的只有“引用槽位”：defineTable 的新建引用（schema、typeRef、refTable、refColumns、
// default.nextval、partitions[].schema）与本表列，以及 alterColumn 的外部引用 typeRef 与 default.nextval
// （同样做歧义检测，按名称解析出的外部 schema ID 记入 extraReads）。
import { z } from 'zod';

import { cleanExt, EditError } from './edit.ts';
import { isReservedId, newId } from './ids.ts';
import {
  ColumnExt,
  FkAction,
  IndexExt,
  type Model,
  type Obj,
  PartitionStrategy,
  PrimaryKeyExt,
  SequenceOptions,
  TableExt,
  UniqueExt,
} from './ir.ts';
import { clonePlain, deepEqual } from './json.ts';
import { all, effectiveColumnsOf } from './model.ts';
import { MSSQL_NOT_NULL_NOTE } from './mssql/nullability.ts';
import { BATCH_OPS_LIMIT, type MutatorName, objectIdArg, objectNameArg, runMutator } from './mutators.ts';
import {
  isPgSerialArrayType,
  parsePgSerialType,
  PG_SERIAL_BASE,
  PG_SERIAL_TYPE_NOTE,
  pgSerialOf,
} from './pg/serial.ts';
import { getDialect } from './registry.ts';
import { SQLITE_COLUMN_TYPE_NOTE } from './sqlite/types.ts';

// ───── 公共类型 ─────

/** 宏展开出的一步底层 mutator：path 是相对宏参数的子路径（如 `foreignKeys[0]`），用于把错误映射回输入 */
export interface MacroStep {
  name: MutatorName;
  args: unknown;
  path: string;
  /** 这一步额外的外部依据（例如按 `schema.name` 解析出的 schema ID，参数里看不到但并发改名会让解析失效） */
  extraReads?: string[];
}

/** 编译结果：steps 是惰性生成器，每次 `next(model)` 传入执行完上一步后的最新模型 */
export interface MacroPlan {
  /** 人类可读的宏标签，如 `defineTable(orders)`、`alterColumn(users.email)` */
  label: string;
  /** 整个宏的外部依据（即使全部步骤都被跳过也要检查并发冲突） */
  extraReads: string[];
  steps: Generator<MacroStep, void, Model>;
}

/** 宏编译 / 展开失败：path 为相对宏参数的子路径（可为空），rawMessage 为原始错误文本 */
export class MacroError extends EditError {
  readonly path: string;
  readonly rawMessage: string;
  readonly mutator?: string;
  constructor(path: string, rawMessage: string, mutator?: string) {
    const head = [path, mutator].filter(Boolean).join(' ');
    super(head ? `${head}：${rawMessage}` : rawMessage);
    this.name = 'MacroError';
    this.path = path;
    this.rawMessage = rawMessage;
    if (mutator !== undefined) this.mutator = mutator;
  }
}

// ───── `$ref:<alias>` 作用域 ─────

/** `$ref:<alias>` 占位符（与 @dowel/api 的 MCP_REF_PATTERN 一致） */
export const MACRO_REF_PATTERN = /^\$ref:[A-Za-z0-9_.-]{1,64}$/;
const REF_PREFIX = '$ref:';
const isRefLike = (raw: string) => raw.startsWith(REF_PREFIX);

/**
 * 严格的 `$ref` 作用域：宏参数不做整体递归替换（comment / expr / where 等自由文本里的字面量 `$ref:` 必须原样保留），
 * 只有定义槽位与引用槽位才解析。refs 与同批普通原语共享（同 alias 同 ID）。
 */
export class RefScope {
  readonly refs: Map<string, string>;
  private readonly model: Model;
  private readonly created = new Set<string>();

  constructor(refs: Map<string, string>, model: Model) {
    this.refs = refs;
    this.model = model;
  }

  /** 定义槽位：省略时生成 UUIDv7；`$ref:` 分配（或复用同 alias 的）ID；新 ID 不能已存在于模型或本宏已建对象中 */
  define(raw: string | undefined, path: string): string {
    let id: string;
    if (raw === undefined) id = newId();
    else if (isRefLike(raw)) {
      if (!MACRO_REF_PATTERN.test(raw)) throw new MacroError(path, badRef(raw));
      const alias = raw.slice(REF_PREFIX.length);
      id = this.refs.get(alias) ?? newId();
      this.refs.set(alias, id);
    } else {
      const parsed = objectIdArg.safeParse(raw);
      if (!parsed.success) throw new MacroError(path, `对象 ID ${raw} 不合法（1-64 个字符，不能是保留名）`);
      id = raw;
    }
    if (isReservedId(id)) throw new MacroError(path, `对象 ID ${raw} 是保留名`);
    if (Object.hasOwn(this.model.objects, id) || this.created.has(id)) {
      throw new MacroError(path, `对象 ID ${raw ?? id} 已存在，新建对象必须使用新的 ID 或新的 $ref:<alias>`);
    }
    this.created.add(id);
    return id;
  }

  /** 引用槽位：`$ref:` 只查不分配（未定义报错）；其他原样返回，由调用方按 ID / 名称解析 */
  lookup(raw: string, path: string, hint?: string): string {
    if (!isRefLike(raw)) return raw;
    if (!MACRO_REF_PATTERN.test(raw)) throw new MacroError(path, badRef(raw));
    const id = this.refs.get(raw.slice(REF_PREFIX.length));
    if (!id) throw new MacroError(path, `未定义的占位符 ${raw}${hint ? `（${hint}）` : ''}`);
    return id;
  }
}

const badRef = (raw: string) =>
  `占位符 ${raw} 不合法（格式为 $ref:<alias>，alias 为 1-64 个字母、数字、_ . -）`;

// ───── 名称解析（大小写规则与原型安全） ─────

const own = (m: Model, id: string): Obj | undefined =>
  Object.hasOwn(m.objects, id) ? m.objects[id] : undefined;
/** schema 名是否大小写不敏感（SQLite / MSSQL） */
const ciSchema = (m: Model) => m.dialect === 'sqlite' || m.dialect === 'mssql';
/** 表 / 列 / 枚举 / 序列名是否大小写不敏感（与剪贴板规则一致） */
const ciIdent = (m: Model) => getDialect(m.dialect).clipboard.caseInsensitiveIdents;
const sameName = (ci: boolean, a: string, b: string) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b);

const schemaNameOf = (m: Model, o: Obj) => {
  const p = 'parent' in o ? own(m, o.parent) : undefined;
  return p?.kind === 'schema' ? p.name : '?';
};

const KIND_LABEL: Record<string, string> = {
  schema: 'schema',
  table: '表',
  enum: '枚举',
  sequence: '序列',
  column: '列',
};

/** 同时命中 ID 与（另一个对象的）名字、或多个对象同名时报歧义；都没命中报不存在 */
const pickOne = <T extends Obj>(
  path: string,
  raw: string,
  kind: string,
  byId: T | undefined,
  byName: T[],
  fmt: (o: T) => string,
  hint?: string,
): T => {
  const names = byName.filter((o) => o !== byId);
  if (byId && names.length) {
    throw new MacroError(
      path,
      `${raw} 有歧义：既是${KIND_LABEL[kind]} ${fmt(byId)} 的 ID，又是${KIND_LABEL[kind]} ${names.map(fmt).join('、')} 的名字，请改用对象 ID`,
    );
  }
  if (byId) return byId;
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new MacroError(
      path,
      `${KIND_LABEL[kind]}名 ${raw} 有歧义，候选：${byName.map(fmt).join('、')}，请改用限定名或对象 ID`,
    );
  }
  throw new MacroError(path, `${KIND_LABEL[kind]} ${raw} 不存在${hint ? `（${hint}）` : ''}`);
};

interface Resolved {
  id: string;
  /** 按名字解析时额外依据的 schema ID */
  reads: string[];
}

const resolveSchema = (m: Model, scope: RefScope, raw: string, path: string): Resolved => {
  if (isRefLike(raw)) {
    const id = scope.lookup(raw, path);
    if (own(m, id)?.kind !== 'schema') throw new MacroError(path, `${raw} 不是 schema`);
    return { id, reads: [] };
  }
  const hit = own(m, raw);
  const byId = hit?.kind === 'schema' ? hit : undefined;
  const ci = ciSchema(m);
  const byName = all(m, 'schema').filter((s) => sameName(ci, s.name, raw));
  const o = pickOne(path, raw, 'schema', byId, byName, (s) => s.name);
  return { id: o.id, reads: o === byId ? [] : [o.id] };
};

const defaultSchemaOf = (m: Model): Resolved => {
  const name = getDialect(m.dialect).capabilities.defaultSchema;
  const schemas = all(m, 'schema');
  const ci = ciSchema(m);
  const hit = schemas.filter((s) => sameName(ci, s.name, name));
  if (hit.length === 1) return { id: hit[0]!.id, reads: [hit[0]!.id] };
  if (schemas.length === 1) return { id: schemas[0]!.id, reads: [schemas[0]!.id] };
  throw new MacroError(
    'schema',
    `未指定 schema，且模型中没有默认 schema ${name}（当前有 ${schemas.length} 个 schema），请显式给出 schema`,
  );
};

/** 解析表 / 枚举 / 序列：`$ref` / 对象 ID / `schema.name` / 全局唯一的非限定名 */
const resolveQualified = <K extends 'table' | 'enum' | 'sequence'>(
  m: Model,
  scope: RefScope,
  raw: string,
  path: string,
  kind: K,
  hint?: string,
): Resolved => {
  if (isRefLike(raw)) {
    const id = scope.lookup(raw, path, hint);
    if (own(m, id)?.kind !== kind) throw new MacroError(path, `${raw} 不是${KIND_LABEL[kind]}`);
    return { id, reads: [] };
  }
  const hit = own(m, raw);
  const byId = hit?.kind === kind ? hit : undefined;
  const ci = ciIdent(m);
  const cis = ciSchema(m);
  const objs = all(m, kind) as Obj[];
  const candidates = new Set<Obj>();
  for (const o of objs) if (sameName(ci, o.name, raw)) candidates.add(o);
  const dot = raw.indexOf('.');
  if (dot > 0 && dot < raw.length - 1) {
    const sPart = raw.slice(0, dot);
    const nPart = raw.slice(dot + 1);
    const schemas = new Set(
      all(m, 'schema')
        .filter((s) => sameName(cis, s.name, sPart))
        .map((s) => s.id),
    );
    for (const o of objs) {
      if ('parent' in o && schemas.has(o.parent) && sameName(ci, o.name, nPart)) candidates.add(o);
    }
  }
  const fmt = (o: Obj) => `${schemaNameOf(m, o)}.${o.name}`;
  const o = pickOne(path, raw, kind, byId, [...candidates], fmt, hint);
  return { id: o.id, reads: o === byId || !('parent' in o) ? [] : [o.parent] };
};

/** 在给定列集合里解析一列：`$ref` / 列 ID / 列名（同时命中某列 ID 与另一列名时报歧义） */
const resolveColumnIn = (
  m: Model,
  scope: RefScope,
  cols: readonly { id: string; name: string }[],
  raw: string,
  path: string,
  tableName: string,
): string => {
  if (isRefLike(raw)) {
    const id = scope.lookup(raw, path);
    if (!cols.some((c) => c.id === id)) throw new MacroError(path, `${raw} 不是表 ${tableName} 的列`);
    return id;
  }
  const ci = ciIdent(m);
  const byId = cols.find((c) => c.id === raw);
  const byName = cols.filter((c) => c !== byId && sameName(ci, c.name, raw));
  if (byId && byName.length) {
    throw new MacroError(
      path,
      `${raw} 有歧义：既是列 ${byId.name} 的 ID，又是列 ${byName.map((c) => c.name).join('、')} 的名字，请改用列 ID`,
    );
  }
  if (byId) return byId.id;
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length > 1) throw new MacroError(path, `列名 ${raw} 在表 ${tableName} 中有歧义，请改用列 ID`);
  throw new MacroError(path, `表 ${tableName} 没有列 ${raw}`);
};

// ───── 参数 schema ─────

/** 把对象（含嵌套的方言子对象）变成 strict：未知字段直接拒绝，而不是静默丢弃 */
const strictDeep = <T extends z.ZodObject>(s: T): T => {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(s.shape as Record<string, z.ZodType>)) {
    let inner: z.ZodType = v;
    const optional = inner instanceof z.ZodOptional;
    if (optional) inner = (inner as z.ZodOptional<z.ZodType>).unwrap();
    if (inner instanceof z.ZodObject) inner = strictDeep(inner);
    shape[k] = optional ? inner.optional() : inner;
  }
  return z.object(shape).strict() as unknown as T;
};

const tableExtArg = strictDeep(TableExt);
const columnExtArg = strictDeep(ColumnExt);
const pkExtArg = strictDeep(PrimaryKeyExt);
const uniqueExtArg = strictDeep(UniqueExt);
const indexExtArg = strictDeep(IndexExt);

/** 新建对象的 ID 槽位：省略自动生成 UUIDv7；可给新的对象 ID 或 `$ref:<alias>` */
const newIdSlot = z
  .string()
  .min(1)
  .max(69)
  .optional()
  .describe('New object ID: omit for an auto UUIDv7, or pass `$ref:<alias>` to reference it later');
/** 引用槽位：对象 ID / `$ref:<alias>` / 名称（表 / 枚举 / 序列可写 `schema.name`） */
const refSlot = z.string().min(1).max(260);
const comment = z.string().nullable().optional();
const keyName = objectNameArg.optional().describe('Explicit constraint / index name (expands to renameKey)');

const macroDefault = z.union([
  z.object({ expr: z.string().min(1) }).strict(),
  z.object({ nextval: refSlot.describe('Sequence: ID / `$ref:<alias>` / `[schema.]name`') }).strict(),
]);

const macroColumn = z
  .object({
    id: newIdSlot,
    name: objectNameArg,
    type: z
      .string()
      .optional()
      .describe(
        `Type text; may be omitted (or only array dims like \`[]\`) when typeRef is set. ${PG_SERIAL_TYPE_NOTE} ${SQLITE_COLUMN_TYPE_NOTE}`,
      ),
    typeRef: refSlot.nullable().optional().describe('PG enum: ID / `$ref:<alias>` / `[schema.]name`'),
    notNull: z.boolean().optional().describe(MSSQL_NOT_NULL_NOTE),
    default: macroDefault.nullable().optional(),
    identity: z
      .object({ always: z.boolean(), options: SequenceOptions.partial().strict().optional() })
      .strict()
      .nullable()
      .optional()
      .describe('PG IDENTITY only (MSSQL uses ext.mssql.identity, MySQL ext.mysql.autoIncrement)'),
    generated: z
      .object({ expr: z.string().min(1), stored: z.boolean() })
      .strict()
      .nullable()
      .optional(),
    collation: z.string().nullable().optional(),
    comment,
    ext: columnExtArg.optional(),
  })
  .strict();

const ownColRef = refSlot.describe('Column of this table: name / column ID / `$ref:<alias>`');

const macroPartitionKey = z
  .object({
    column: ownColRef.optional(),
    expr: z.string().min(1).optional(),
    opclass: z.string().min(1).nullable().optional(),
    collation: z.string().min(1).nullable().optional(),
  })
  .strict();

const macroIndexElement = z
  .object({
    column: ownColRef.optional(),
    expr: z.string().min(1).optional(),
    desc: z.boolean().optional(),
    nullsFirst: z.boolean().nullable().optional(),
    opclass: z.string().nullable().optional(),
    collation: z.string().nullable().optional(),
  })
  .strict();

const list = <T extends z.ZodType>(t: T) => z.array(t).max(BATCH_OPS_LIMIT);
const colList = z.array(ownColRef).min(1).max(BATCH_OPS_LIMIT);

export const defineTableArgs = z
  .object({
    id: newIdSlot,
    schema: refSlot
      .optional()
      .describe('Schema: ID / `$ref:<alias>` / name; defaults to the dialect default schema'),
    name: objectNameArg,
    comment,
    ext: tableExtArg.optional(),
    columns: z.array(macroColumn).min(1).max(BATCH_OPS_LIMIT).describe('Columns in display order'),
    partitionBy: z
      .object({ strategy: PartitionStrategy, keys: z.array(macroPartitionKey).min(1) })
      .strict()
      .optional(),
    partitions: list(
      z
        .object({
          id: newIdSlot,
          name: objectNameArg,
          bound: z.string().min(1),
          schema: refSlot.optional(),
          comment,
        })
        .strict(),
    ).optional(),
    primaryKey: z
      .object({ id: newIdSlot, name: keyName, columns: colList, ext: pkExtArg.optional(), comment })
      .strict()
      .optional(),
    uniques: list(
      z
        .object({
          id: newIdSlot,
          name: keyName,
          columns: colList,
          nullsNotDistinct: z.boolean().optional(),
          ext: uniqueExtArg.optional(),
          comment,
        })
        .strict(),
    ).optional(),
    checks: list(
      z
        .object({
          id: newIdSlot,
          name: keyName,
          expr: z.string().min(1),
          noInherit: z.boolean().optional(),
          comment,
        })
        .strict(),
    ).optional(),
    indexes: list(
      z
        .object({
          id: newIdSlot,
          name: keyName,
          elements: z.array(macroIndexElement).min(1).max(BATCH_OPS_LIMIT),
          unique: z.boolean().optional(),
          method: z.string().optional(),
          include: z.array(ownColRef).max(BATCH_OPS_LIMIT).optional(),
          where: z.string().nullable().optional(),
          nullsNotDistinct: z.boolean().optional(),
          ext: indexExtArg.optional(),
          comment,
        })
        .strict(),
    ).optional(),
    foreignKeys: list(
      z
        .object({
          id: newIdSlot,
          name: keyName,
          columns: colList,
          refTable: refSlot.describe(
            'Referenced table: this table (self-reference) / ID / `$ref:<alias>` of an earlier table / `schema.table` / globally unique name',
          ),
          refColumns: z
            .array(refSlot.describe('Referenced column: name / ID / `$ref:<alias>`'))
            .min(1)
            .max(BATCH_OPS_LIMIT),
          onDelete: FkAction.optional(),
          onUpdate: FkAction.optional(),
          match: z.enum(['simple', 'full']).optional(),
          deferrable: z.boolean().optional(),
          initiallyDeferred: z.boolean().optional(),
          comment,
        })
        .strict(),
    ).optional(),
  })
  .strict();
export type DefineTableArgs = z.infer<typeof defineTableArgs>;

const ALTER_FIELDS = ['name', 'type', 'typeRef', 'notNull', 'default', 'identity', 'ext', 'comment'] as const;

export const alterColumnArgs = z
  .object({
    id: z
      .string()
      .min(1)
      .max(69)
      .describe(
        'Existing column ID, or `$ref:<alias>` of a column created earlier in this batch (never a name)',
      ),
    name: objectNameArg.optional(),
    type: z.string().optional().describe(`Type text. ${PG_SERIAL_TYPE_NOTE} ${SQLITE_COLUMN_TYPE_NOTE}`),
    typeRef: refSlot
      .nullable()
      .optional()
      .describe('PG enum: ID / `$ref:<alias>` / `[schema.]name`; null switches back to a plain type'),
    notNull: z.boolean().optional().describe(MSSQL_NOT_NULL_NOTE),
    default: macroDefault.nullable().optional(),
    identity: z.object({ always: z.boolean() }).strict().nullable().optional(),
    ext: columnExtArg
      .nullable()
      .optional()
      .describe(
        'Replaces the whole column ext (null clears it). SQL Server: an explicit default-constraint name (ext.mssql.defaultNameMode "explicit") is kept automatically when the column still has a default after this alterColumn, unless ext.mssql sets defaultName / defaultNameMode or ext is null',
      ),
    comment,
  })
  .strict()
  .refine((a) => ALTER_FIELDS.some((k) => a[k] !== undefined), {
    message: 'alterColumn 至少需要一个要修改的字段',
  });
export type AlterColumnArgs = z.infer<typeof alterColumnArgs>;

// ───── 共用校验 ─────

const DIMS_RE = /^(\[\])+$/;

const identityHint = (m: Model) => {
  switch (m.dialect) {
    case 'mssql':
      return 'SQL Server 不使用 PG IDENTITY，自增列请用 ext.mssql.identity（{ seed, increment }）';
    case 'mysql':
      return 'MySQL 不支持 PG IDENTITY，自增列请用 ext.mysql.autoIncrement';
    case 'sqlite':
      return 'SQLite 不支持 PG IDENTITY，自增请用 INTEGER 单列主键 + ext.sqlite.autoincrement';
    default:
      return '当前方言不支持 PG IDENTITY';
  }
};

/** typeRef 指向枚举时 type 只能省略、只写数组维度，或写成 `[schema.]枚举名` 加数组维度；返回去掉前缀后的维度 */
const enumDimsOf = (m: Model, enumId: string, type: string): string | null => {
  const t = type.trim();
  if (t === '' || DIMS_RE.test(t)) return t;
  const e = own(m, enumId);
  if (e?.kind !== 'enum') return null;
  const ci = ciIdent(m);
  for (const prefix of [`${schemaNameOf(m, e)}.${e.name}`, e.name]) {
    if (t.length >= prefix.length && sameName(ci, t.slice(0, prefix.length), prefix)) {
      const rest = t.slice(prefix.length).trim();
      if (rest === '' || DIMS_RE.test(rest)) return rest;
    }
  }
  return null;
};

const enumDimsOrThrow = (m: Model, enumId: string, type: string, path: string): string => {
  const dims = enumDimsOf(m, enumId, type);
  if (dims === null) {
    const e = own(m, enumId);
    throw new MacroError(
      path,
      `typeRef 指向枚举 ${e?.name ?? enumId} 时，type 只能省略、只写数组维度（如 []）或写成该枚举名加数组维度（当前为 ${type}）`,
    );
  }
  return dims;
};

const resolveDefault = (
  m: Model,
  scope: RefScope,
  def: z.infer<typeof macroDefault>,
  path: string,
): { value: { expr: string } | { nextval: string }; reads: string[] } => {
  if ('expr' in def) return { value: { expr: def.expr }, reads: [] };
  const r = resolveQualified(m, scope, def.nextval, `${path}.nextval`, 'sequence');
  return { value: { nextval: r.id }, reads: r.reads };
};

/** 只保留值不是 undefined 的键（让展开后的原语参数与人工书写的一致、可读） */
const defined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

const step = (name: MutatorName, args: unknown, path: string, extraReads?: string[]): MacroStep => ({
  name,
  args: clonePlain(args),
  path,
  ...(extraReads?.length ? { extraReads } : {}),
});

const join = (base: string, k: string) => (base ? `${base}.${k}` : k);

// ───── defineTable ─────

const compileDefineTable = (m0: Model, a: DefineTableArgs, scope: RefScope, label: string): MacroPlan => {
  const caps = getDialect(m0.dialect).capabilities;

  // 编译期校验（参数自身的互斥与完整性）
  if (a.partitions?.length && !a.partitionBy) {
    throw new MacroError('partitions', '定义子分区需要同时给出 partitionBy');
  }
  a.columns.forEach((c, k) => {
    const p = `columns[${k}]`;
    const hasIdentity = c.identity != null;
    const hasGenerated = c.generated != null;
    const hasDefault = c.default != null;
    if (hasIdentity && m0.dialect !== 'pg') throw new MacroError(`${p}.identity`, identityHint(m0));
    if (m0.dialect === 'pg' && c.typeRef == null) {
      const rawType = c.type ?? '';
      if (isPgSerialArrayType(rawType)) throw new MacroError(`${p}.type`, 'serial 不能用作数组类型');
      if (parsePgSerialType(rawType)) {
        if (hasIdentity) throw new MacroError(p, 'serial 列不能同时是 identity');
        if (hasGenerated) throw new MacroError(p, 'serial 列不能同时是生成列');
        if (hasDefault) throw new MacroError(p, 'serial 列不能有默认值');
        if (c.notNull === false) throw new MacroError(p, 'serial 列必须 NOT NULL');
      }
    }
    if (hasIdentity && hasGenerated) throw new MacroError(p, 'identity 列不能同时是生成列');
    if (hasIdentity && hasDefault) throw new MacroError(p, 'identity 列不能有默认值');
    if (hasGenerated && hasDefault) throw new MacroError(p, '生成列不能有默认值');
    if (hasIdentity && c.notNull === false) throw new MacroError(p, 'identity 列必须 NOT NULL');
    if (c.typeRef != null) {
      if (!caps.enums) throw new MacroError(`${p}.typeRef`, '当前方言不支持独立枚举类型');
    } else if (m0.dialect === 'sqlite') {
      if (c.type === undefined) {
        throw new MacroError(`${p}.type`, '缺少列类型（SQLite 非 STRICT 表可显式传 type: "" 声明无类型列）');
      }
      if (!c.type.trim() && a.ext?.sqlite?.strict) {
        throw new MacroError(
          `${p}.type`,
          'STRICT 表的列必须声明类型（仅允许 INT/INTEGER/REAL/TEXT/BLOB/ANY）',
        );
      }
    } else if (!(c.type ?? '').trim()) {
      throw new MacroError(`${p}.type`, '缺少列类型');
    }
  });
  a.partitionBy?.keys.forEach((k, j) => {
    if ((k.column !== undefined) === (k.expr !== undefined)) {
      throw new MacroError(`partitionBy.keys[${j}]`, '分区键必须且只能指定 column 或 expr 之一');
    }
  });

  // 分配本宏新建对象的 ID（定义槽位，查重：既不能在模型里，也不能在本宏已建集合里）
  const tableId = scope.define(a.id, 'id');
  const cols = a.columns.map((c, k) => ({ id: scope.define(c.id, `columns[${k}].id`), name: c.name, c }));
  const pkId = a.primaryKey ? scope.define(a.primaryKey.id, 'primaryKey.id') : null;
  const uqIds = (a.uniques ?? []).map((u, k) => scope.define(u.id, `uniques[${k}].id`));
  const ckIds = (a.checks ?? []).map((c, k) => scope.define(c.id, `checks[${k}].id`));
  const ixIds = (a.indexes ?? []).map((x, k) => scope.define(x.id, `indexes[${k}].id`));
  const fkIds = (a.foreignKeys ?? []).map((f, k) => scope.define(f.id, `foreignKeys[${k}].id`));
  const ptIds = (a.partitions ?? []).map((p, k) => scope.define(p.id, `partitions[${k}].id`));

  // 本表列引用：名称 / 列 ID / `$ref`（编译期即可确定）
  const ownCol = (raw: string, path: string) => resolveColumnIn(m0, scope, cols, raw, path, a.name);
  const ownCols = (raws: string[], path: string) => raws.map((r, j) => ownCol(r, `${path}[${j}]`));
  const pkCols = a.primaryKey ? ownCols(a.primaryKey.columns, 'primaryKey.columns') : [];
  const uqCols = (a.uniques ?? []).map((u, k) => ownCols(u.columns, `uniques[${k}].columns`));
  const fkCols = (a.foreignKeys ?? []).map((f, k) => ownCols(f.columns, `foreignKeys[${k}].columns`));
  const ixEls = (a.indexes ?? []).map((x, k) =>
    x.elements.map((e, j) =>
      defined({
        ...e,
        column: e.column !== undefined ? ownCol(e.column, `indexes[${k}].elements[${j}].column`) : undefined,
      }),
    ),
  );
  const ixInclude = (a.indexes ?? []).map((x, k) =>
    x.include ? ownCols(x.include, `indexes[${k}].include`) : undefined,
  );
  const partitionBy = a.partitionBy
    ? {
        strategy: a.partitionBy.strategy,
        keys: a.partitionBy.keys.map((k, j) => ({
          column: k.column !== undefined ? ownCol(k.column, `partitionBy.keys[${j}].column`) : null,
          expr: k.expr ?? null,
          opclass: k.opclass ?? null,
          collation: k.collation ?? null,
        })),
      }
    : null;

  const deferAutoinc = (c: (typeof cols)[number]['c']) =>
    m0.dialect === 'sqlite' && c.ext?.sqlite?.autoincrement === true;

  function* run(): Generator<MacroStep, void, Model> {
    let m = m0;

    // 1. createTable（不内联 partitionBy / ext，分别在后面单独展开以精确定位错误）
    const sch = a.schema === undefined ? defaultSchemaOf(m) : resolveSchema(m, scope, a.schema, 'schema');
    m = yield step('createTable', { id: tableId, schema: sch.id, name: a.name }, '', sch.reads);

    // 2. 列（列顺序即数组顺序；SQLite AUTOINCREMENT 延后到主键与表扩展之后再挂）
    for (let k = 0; k < cols.length; k++) {
      const { id, c } = cols[k]!;
      const p = `columns[${k}]`;
      const reads: string[] = [];
      let typeRef: string | null = null;
      let type = (c.type ?? '').trim();
      if (c.typeRef != null) {
        const r = resolveQualified(m, scope, c.typeRef, `${p}.typeRef`, 'enum');
        typeRef = r.id;
        reads.push(...r.reads);
        type = enumDimsOrThrow(m, r.id, c.type ?? '', `${p}.type`);
      }
      let def: { expr: string } | { nextval: string } | undefined;
      if (c.default != null) {
        const r = resolveDefault(m, scope, c.default, `${p}.default`);
        def = r.value;
        reads.push(...r.reads);
      }
      let ext = c.ext;
      if (deferAutoinc(c)) {
        ext = cleanExt({ ...c.ext, sqlite: { ...c.ext!.sqlite, autoincrement: undefined } });
      }
      const column = defined({
        id,
        name: c.name,
        type,
        typeRef: typeRef ?? undefined,
        notNull: c.notNull,
        default: def,
        identity: c.identity ?? undefined,
        generated: c.generated ?? undefined,
        collation: c.collation ?? undefined,
        ext: cleanExt(ext),
      });
      m = yield step('addColumn', { table: tableId, column }, p, reads);
    }

    // 3. 分区键（在列之后、约束之前：违反分区键要求的约束会准确报错到对应约束）
    if (partitionBy) m = yield step('setPartitionBy', { id: tableId, partitionBy }, 'partitionBy');

    // 4. 主键（+ 显式名紧跟在后）
    if (a.primaryKey && pkId) {
      const ext = cleanExt(a.primaryKey.ext);
      m = yield step(
        'addPrimaryKey',
        defined({ id: pkId, table: tableId, columns: pkCols, ext }),
        'primaryKey',
      );
      if (a.primaryKey.name !== undefined) {
        m = yield step('renameKey', { id: pkId, name: a.primaryKey.name }, 'primaryKey.name');
      }
    }

    // 5. 表扩展（在主键之后：SQLite WITHOUT ROWID / STRICT 能完整校验并精确报错在 .ext）
    const tableExt = cleanExt(a.ext);
    if (tableExt) m = yield step('setTableExt', { id: tableId, ext: tableExt }, 'ext');

    // 6. 延后的 SQLite AUTOINCREMENT（主键与表扩展都就位后再挂，错误精确定位到 .columns[k].ext）
    for (let k = 0; k < cols.length; k++) {
      const { id, c } = cols[k]!;
      if (deferAutoinc(c)) m = yield step('setColumnExt', { id, ext: cleanExt(c.ext) }, `columns[${k}].ext`);
    }

    // 7. 唯一约束
    for (let k = 0; k < uqIds.length; k++) {
      const u = a.uniques![k]!;
      const id = uqIds[k]!;
      m = yield step(
        'addUnique',
        defined({
          id,
          table: tableId,
          columns: uqCols[k],
          nullsNotDistinct: u.nullsNotDistinct,
          ext: cleanExt(u.ext),
        }),
        `uniques[${k}]`,
      );
      if (u.name !== undefined) m = yield step('renameKey', { id, name: u.name }, `uniques[${k}].name`);
    }

    // 8. CHECK
    for (let k = 0; k < ckIds.length; k++) {
      const c = a.checks![k]!;
      const id = ckIds[k]!;
      m = yield step(
        'addCheck',
        defined({ id, table: tableId, expr: c.expr, noInherit: c.noInherit }),
        `checks[${k}]`,
      );
      if (c.name !== undefined) m = yield step('renameKey', { id, name: c.name }, `checks[${k}].name`);
    }

    // 9. 索引
    for (let k = 0; k < ixIds.length; k++) {
      const x = a.indexes![k]!;
      const id = ixIds[k]!;
      m = yield step(
        'addIndex',
        defined({
          id,
          table: tableId,
          elements: ixEls[k],
          unique: x.unique,
          method: x.method,
          include: ixInclude[k],
          where: x.where,
          nullsNotDistinct: x.nullsNotDistinct,
          ext: cleanExt(x.ext),
        }),
        `indexes[${k}]`,
      );
      if (x.name !== undefined) m = yield step('renameKey', { id, name: x.name }, `indexes[${k}].name`);
    }

    // 10. 外键（引用表在执行到这一步时按最新模型解析：天然支持本表自引用与同批前序表）
    for (let k = 0; k < fkIds.length; k++) {
      const f = a.foreignKeys![k]!;
      const id = fkIds[k]!;
      const p = `foreignKeys[${k}]`;
      const ref = resolveQualified(
        m,
        scope,
        f.refTable,
        `${p}.refTable`,
        'table',
        '外键只能引用本表或本批前面已建的表；循环外键请先用 defineTable 建好各表，最后用 addForeignKey 补外键',
      );
      const refTable = own(m, ref.id)!;
      const refCols = effectiveColumnsOf(m, ref.id);
      const refColumns = f.refColumns.map((r, j) =>
        resolveColumnIn(m, scope, refCols, r, `${p}.refColumns[${j}]`, refTable.name),
      );
      m = yield step(
        'addForeignKey',
        defined({
          id,
          table: tableId,
          columns: fkCols[k],
          refTable: ref.id,
          refColumns,
          onDelete: f.onDelete,
          onUpdate: f.onUpdate,
          match: f.match,
          deferrable: f.deferrable,
          initiallyDeferred: f.initiallyDeferred,
        }),
        p,
        ref.reads,
      );
      if (f.name !== undefined) m = yield step('renameKey', { id, name: f.name }, `${p}.name`);
    }

    // 11. 子分区
    for (let k = 0; k < ptIds.length; k++) {
      const pt = a.partitions![k]!;
      const p = `partitions[${k}]`;
      const sch = pt.schema !== undefined ? resolveSchema(m, scope, pt.schema, `${p}.schema`) : null;
      m = yield step(
        'createPartition',
        defined({ id: ptIds[k]!, parent: tableId, name: pt.name, bound: pt.bound, schema: sch?.id }),
        p,
        sch?.reads,
      );
    }

    // 12. 注释（全部对象建好之后统一设置）
    const comments: [string, string | null | undefined, string][] = [
      [tableId, a.comment, 'comment'],
      ...cols.map((c, k): [string, string | null | undefined, string] => [
        c.id,
        c.c.comment,
        `columns[${k}].comment`,
      ]),
      ...(pkId
        ? [[pkId, a.primaryKey?.comment, 'primaryKey.comment'] as [string, string | null | undefined, string]]
        : []),
      ...uqIds.map((id, k): [string, string | null | undefined, string] => [
        id,
        a.uniques![k]!.comment,
        `uniques[${k}].comment`,
      ]),
      ...ckIds.map((id, k): [string, string | null | undefined, string] => [
        id,
        a.checks![k]!.comment,
        `checks[${k}].comment`,
      ]),
      ...ixIds.map((id, k): [string, string | null | undefined, string] => [
        id,
        a.indexes![k]!.comment,
        `indexes[${k}].comment`,
      ]),
      ...fkIds.map((id, k): [string, string | null | undefined, string] => [
        id,
        a.foreignKeys![k]!.comment,
        `foreignKeys[${k}].comment`,
      ]),
      ...ptIds.map((id, k): [string, string | null | undefined, string] => [
        id,
        a.partitions![k]!.comment,
        `partitions[${k}].comment`,
      ]),
    ];
    for (const [id, text, path] of comments) {
      if (text != null) m = yield step('setComment', { id, comment: text }, path);
    }
  }

  return { label, extraReads: [], steps: run() };
};

// ───── alterColumn ─────

/** 只认已有列 ID 或同批前序 `$ref:<alias>`（绝不按列名解析） */
const existingColumnId = (m: Model, scope: RefScope, raw: string): string => {
  const id = scope.lookup(raw, 'id', 'alterColumn 只能修改已有列或本批前面已建的列');
  if (own(m, id)?.kind !== 'column') {
    throw new MacroError(
      'id',
      `列 ${raw} 不存在（alterColumn 只接受已有列 ID 或同批前序 $ref:<alias>，不按列名解析）`,
    );
  }
  return id;
};

/**
 * alterColumn 的目标列扩展：整体替换（null 清空）。MSSQL 例外：列有默认值且当前默认约束名是显式的
 * （defaultNameMode: 'explicit'），而调用方没有在 ext.mssql 里指定 defaultName / defaultNameMode 时，
 * 自动保留原有的显式名（避免一次无关的 ext 修改顺带改掉默认约束名）；传 ext: null 或显式指定时按调用方请求。
 */
const targetColumnExt = (
  m: Model,
  ext: ColumnExt | null,
  cur: Extract<Obj, { kind: 'column' }>,
): ColumnExt | null => {
  if (ext === null) return null;
  const x: ColumnExt = clonePlain(cleanExt(ext)) ?? {};
  const curMssql = cur.ext?.mssql;
  if (
    m.dialect === 'mssql' &&
    cur.default !== null &&
    curMssql?.defaultNameMode === 'explicit' &&
    curMssql.defaultName !== undefined &&
    x.mssql?.defaultName === undefined &&
    x.mssql?.defaultNameMode === undefined
  ) {
    x.mssql = { ...x.mssql, defaultName: curMssql.defaultName, defaultNameMode: 'explicit' };
  }
  return cleanExt(x) ?? null;
};

/** 比较列扩展时忽略 MSSQL 自动推导的默认约束名（defaultName / defaultNameMode 为 derived 或缺省） */
const comparableExt = (m: Model, ext: ColumnExt | null | undefined): ColumnExt | undefined => {
  const x = clonePlain(cleanExt(ext ?? undefined));
  if (m.dialect === 'mssql' && x?.mssql && (x.mssql.defaultNameMode ?? 'derived') === 'derived') {
    delete x.mssql.defaultName;
    delete x.mssql.defaultNameMode;
  }
  // 引擎推断的非空是派生字段（setColumnExt 忽略传入值、保留当前值，ADR 0019），不算 ext 的变化
  if (x?.mssql) delete x.mssql.inferredNotNull;
  return cleanExt(x);
};

const compileAlterColumn = (m0: Model, a: AlterColumnArgs, scope: RefScope, label: string): MacroPlan => {
  const colId = existingColumnId(m0, scope, a.id);
  const c0 = m0.objects[colId] as Extract<Obj, { kind: 'column' }>;
  const caps = getDialect(m0.dialect).capabilities;

  if (a.identity != null && m0.dialect !== 'pg') throw new MacroError('identity', identityHint(m0));
  if (a.identity != null && a.default != null) throw new MacroError('', 'identity 列不能有默认值');
  if (a.identity != null && a.notNull === false) throw new MacroError('', 'identity 列必须 NOT NULL');
  if (a.typeRef != null && !caps.enums) throw new MacroError('typeRef', '当前方言不支持独立枚举类型');
  if (a.typeRef == null && a.type !== undefined) {
    const t = a.type.trim();
    const clearingEnum = a.typeRef === null && c0.typeRef !== null;
    if (clearingEnum && (t === '' || DIMS_RE.test(t))) {
      throw new MacroError('type', '把枚举列改回普通类型（typeRef: null）时需要给出新的 type');
    }
    if (c0.typeRef === null && t === '') {
      if (m0.dialect === 'sqlite') {
        const parentTbl = own(m0, c0.parent);
        if (parentTbl?.kind === 'table' && parentTbl.ext?.sqlite?.strict) {
          throw new MacroError('type', 'STRICT 表的列必须声明类型（仅允许 INT/INTEGER/REAL/TEXT/BLOB/ANY）');
        }
      } else {
        throw new MacroError('type', '列类型不能为空');
      }
    }
  } else if (a.typeRef === null && c0.typeRef !== null) {
    throw new MacroError('type', '把枚举列改回普通类型（typeRef: null）时需要给出新的 type');
  }
  const keepsEnum =
    a.typeRef === undefined &&
    c0.typeRef !== null &&
    a.type !== undefined &&
    enumDimsOf(m0, c0.typeRef, a.type.trim()) !== null;
  if (m0.dialect === 'pg' && a.typeRef == null && a.type !== undefined && !keepsEnum) {
    if (isPgSerialArrayType(a.type)) throw new MacroError('type', 'serial 不能用作数组类型');
    if (parsePgSerialType(a.type)) {
      if (a.identity != null) throw new MacroError('', 'serial 列不能同时是 identity');
      if (a.default != null) throw new MacroError('', 'serial 列不能有默认值');
      if (a.notNull === false) throw new MacroError('', 'serial 列必须 NOT NULL');
    }
  }

  function* run(): Generator<MacroStep, void, Model> {
    let m = m0;
    const col = () => m.objects[colId] as Extract<Obj, { kind: 'column' }>;

    // 1. 取消 identity
    if (a.identity === null && col().identity) {
      m = yield step('setIdentity', { id: colId, identity: null }, 'identity');
    }
    // 2. 清除默认值（显式清除，或将要设为 identity）
    if ((a.default === null || a.identity != null) && col().default !== null) {
      m = yield step('setDefault', { id: colId, default: null }, 'default');
    }
    // 3. 改名
    if (a.name !== undefined && a.name !== col().name) {
      m = yield step('renameColumn', { id: colId, name: a.name }, 'name');
    }
    // 4. 类型（type / typeRef 联合语义）
    {
      const c = col();
      let target: { type: string; typeRef: string | null } | null = null;
      let forceTypeStep = false;
      const reads: string[] = [];
      if (a.typeRef != null) {
        const r = resolveQualified(m, scope, a.typeRef, 'typeRef', 'enum');
        reads.push(...r.reads);
        const dims =
          a.type !== undefined
            ? enumDimsOrThrow(m, r.id, a.type, 'type')
            : c.typeRef !== null && DIMS_RE.test(c.type)
              ? c.type
              : '';
        target = { type: dims, typeRef: r.id };
      } else if (a.type !== undefined) {
        const t = a.type.trim();
        // 枚举列只改数组维度（或写成枚举名加维度）时保留枚举；否则切换为普通类型
        const dims = a.typeRef === undefined && c.typeRef !== null ? enumDimsOf(m, c.typeRef, t) : null;
        if (dims !== null) {
          target = { type: dims, typeRef: c.typeRef };
        } else {
          const serialKind = m.dialect === 'pg' ? parsePgSerialType(t) : null;
          if (serialKind) {
            const base = PG_SERIAL_BASE[serialKind];
            const curSerial = pgSerialOf(m, c);
            if (!(curSerial?.kind === serialKind && c.notNull && curSerial.sequence.options.type === base)) {
              target = { type: serialKind, typeRef: null };
              forceTypeStep = true;
            }
          } else {
            // 普通类型按方言规范写法比较（setColumnType 也会这样写入），int → integer 这类只换写法的修改不产生空操作
            target = { type: t ? getDialect(m.dialect).normalizeType(t) : t, typeRef: null };
          }
        }
      }
      if (target && (forceTypeStep || target.type !== c.type || target.typeRef !== c.typeRef)) {
        m = yield step(
          'setColumnType',
          { id: colId, ...target },
          a.typeRef !== undefined ? 'typeRef' : 'type',
          reads,
        );
      }
    }
    // 5. NOT NULL
    if (a.notNull !== undefined && a.notNull !== col().notNull) {
      m = yield step('setNotNull', { id: colId, notNull: a.notNull }, 'notNull');
    }
    // 6. 设置默认值
    if (a.default != null) {
      const r = resolveDefault(m, scope, a.default, 'default');
      if (!deepEqual(r.value, col().default)) {
        m = yield step('setDefault', { id: colId, default: r.value }, 'default', r.reads);
      }
    }
    // 7. 设置 identity
    if (a.identity != null) {
      const cur = col().identity;
      if (!cur || cur.always !== a.identity.always) {
        m = yield step('setIdentity', { id: colId, identity: { always: a.identity.always } }, 'identity');
      }
    }
    // 8. 列扩展（整体替换；MSSQL 比较时忽略自动推导的默认约束名，并自动保留显式默认约束名）
    if (a.ext !== undefined) {
      const target = targetColumnExt(m, a.ext, col());
      if (!deepEqual(comparableExt(m, target), comparableExt(m, col().ext))) {
        m = yield step('setColumnExt', { id: colId, ext: target }, 'ext');
      }
    }
    // 9. 注释
    if (a.comment !== undefined && a.comment !== col().comment) {
      m = yield step('setComment', { id: colId, comment: a.comment }, 'comment');
    }
  }

  return { label, extraReads: [colId], steps: run() };
};

// ───── 注册表与入口 ─────

interface MacroDef<A extends z.ZodType> {
  args: A;
  description: string;
  compile: (m: Model, a: z.infer<A>, scope: RefScope, label: string) => MacroPlan;
}
const macroDef = <A extends z.ZodType>(d: MacroDef<A>) => d;

/** 编译型复合宏注册表（只在 MCP apply_changes 输入层使用，不是同步层 mutator） */
export const macros = {
  defineTable: macroDef({
    args: defineTableArgs,
    description: `Macro: create a table with columns, primary key, uniques, checks, indexes, foreign keys, comments, ext and optional partitions in one op. Columns / keys may refer to this table's columns by name; schema / typeRef / refTable / refColumns / default.nextval / partitions[].schema may be resolved by ID, \`$ref:<alias>\` or (qualified) name. Expands to primitive mutators in a fixed order (createTable → addColumn → setPartitionBy → addPrimaryKey (+ renameKey) → setTableExt → deferred SQLite setColumnExt (autoincrement) → addUnique / addCheck / addIndex / addForeignKey (each followed by renameKey when \`name\` is given) → createPartition → setComment). For circular foreign keys, define all tables first and add the remaining FKs with addForeignKey. ${PG_SERIAL_TYPE_NOTE} ${SQLITE_COLUMN_TYPE_NOTE}`,
    compile: compileDefineTable,
  }),
  alterColumn: macroDef({
    args: alterColumnArgs,
    description: `Macro: declaratively patch an existing column (name, type / typeRef, notNull, default, identity, ext, comment; omitted = unchanged, null = clear). \`id\` must be an existing column ID or a \`$ref:<alias>\` created earlier in this batch — never a name; the references typeRef / default.nextval may also be ID, \`$ref\` or \`[schema.]name\`. \`ext\` replaces the whole column ext (null clears it); on SQL Server an explicit default-constraint name is kept automatically unless ext.mssql sets defaultName / defaultNameMode. Expands safely in the order: drop identity → clear default → renameColumn → setColumnType → setNotNull → set default → set identity → setColumnExt → setComment; steps whose value already matches are skipped. ${PG_SERIAL_TYPE_NOTE} ${SQLITE_COLUMN_TYPE_NOTE}`,
    compile: compileAlterColumn,
  }),
};
export type MacroName = keyof typeof macros;

export const isMacro = (name: string): name is MacroName => Object.hasOwn(macros, name);

/** 宏的人类可读标签（参数不合法时也能给出，便于错误定位） */
export const macroLabel = (m: Model, name: string, args: unknown, refs?: Map<string, string>): string => {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (name === 'defineTable') return typeof a.name === 'string' ? `defineTable(${a.name})` : 'defineTable';
  if (name === 'alterColumn') {
    if (typeof a.id !== 'string') return 'alterColumn';
    const id = isRefLike(a.id) ? refs?.get(a.id.slice(REF_PREFIX.length)) : a.id;
    const c = id ? own(m, id) : undefined;
    if (c?.kind === 'column') {
      const t = own(m, c.parent);
      return `alterColumn(${t ? `${t.name}.` : ''}${c.name})`;
    }
    return `alterColumn(${a.id})`;
  }
  return name;
};

const zodPath = (path: readonly PropertyKey[]) =>
  path.reduce<string>((s, k) => (typeof k === 'number' ? `${s}[${k}]` : join(s, String(k))), '');

/**
 * 编译一个宏：校验参数（zod strict）与互斥规则、分配新建对象 ID，返回惰性展开计划。
 * refs 与同批普通原语共享（`$ref:<alias>` → ID）。参数不合法抛 MacroError（path 为相对宏参数的子路径）。
 */
export const compileMacro = (m: Model, name: string, args: unknown, refs: Map<string, string>): MacroPlan => {
  if (!isMacro(name)) throw new MacroError('', `未知的宏：${name}`);
  const def = macros[name] as MacroDef<z.ZodType>;
  const label = macroLabel(m, name, args, refs);
  const parsed = def.args.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new MacroError(issue ? zodPath(issue.path) : '', `参数不合法：${issue?.message ?? ''}`);
  }
  return def.compile(m, parsed.data, new RefScope(refs, m), label);
};

/**
 * 纯参考执行器：在模型上（原地）编译并逐步执行宏，返回展开后的原语序列。
 * 结果与把这些原语交给 `runMutator(m, 'batch', { ops })` 等价（供四方言单测直接验证）。
 * 子操作失败抛 MacroError（带子路径与 mutator 名）。
 */
export const runMacro = (
  m: Model,
  name: string,
  args: unknown,
  refs: Map<string, string> = new Map(),
): {
  label: string;
  ops: { name: MutatorName; args: unknown }[];
  steps: MacroStep[];
  extraReads: string[];
  refs: Map<string, string>;
} => {
  const plan = compileMacro(m, name, args, refs);
  const ops: { name: MutatorName; args: unknown }[] = [];
  const steps: MacroStep[] = [];
  for (let r = plan.steps.next(m); !r.done; r = plan.steps.next(m)) {
    const s = r.value;
    try {
      runMutator(m, s.name, s.args);
    } catch (e) {
      if (e instanceof EditError && !(e instanceof MacroError))
        throw new MacroError(s.path, e.message, s.name);
      throw e;
    }
    ops.push({ name: s.name, args: s.args });
    steps.push(s);
  }
  return { label: plan.label, ops, steps, extraReads: plan.extraReads, refs };
};
