// IR：项目 schema 的唯一数据源。设计见 .agents/docs/04-ir-design.md 第 1 节。
// 所有对象扁平存放在 objects 里，按 ID 索引，用 parent 表示从属关系。
import { z } from 'zod';

export const FORMAT = 1;

const id = z.string().min(1);
const name = z.string().min(1).max(63);
/** 推导名（按引擎规则由表名、列名算出，改名时跟着改）或显式名（用户指定或锁定，不跟着改） */
const nameMode = z.enum(['derived', 'explicit']);
const comment = z.string().nullable().default(null);

export const Schema = z.object({
  id,
  kind: z.literal('schema'),
  name,
  comment,
});

export const Enum = z.object({
  id,
  kind: z.literal('enum'),
  parent: id, // schema
  name,
  values: z.array(z.string().min(1)).min(1),
  comment,
});

export const SequenceOptions = z.object({
  type: z.enum(['smallint', 'integer', 'bigint']).default('bigint'),
  increment: z.string().default('1'), // 字符串：bigint 范围超出 JS number 精度
  min: z.string().nullable().default(null), // null = 类型默认值
  max: z.string().nullable().default(null),
  start: z.string().nullable().default(null),
  cache: z.string().default('1'),
  cycle: z.boolean().default(false),
});

export const Sequence = z.object({
  id,
  kind: z.literal('sequence'),
  parent: id, // schema
  name,
  nameMode: nameMode.default('explicit'),
  ownedBy: id.nullable().default(null), // column
  options: SequenceOptions.prefault({}),
  comment,
});

export const Table = z.object({
  id,
  kind: z.literal('table'),
  parent: id, // schema
  name,
  /** 分区表的分区键（pg_get_partkeydef 的输出，如 `RANGE (payment_date)`）。M1 只读 */
  partitionBy: z.string().nullable().default(null),
  /** 分区子表：所属的分区表和分区边界（如 `FOR VALUES FROM (...) TO (...)`）。M1 只读 */
  partitionOf: z.object({ parent: id, bound: z.string() }).nullable().default(null),
  comment,
});

export const ColumnDefault = z.union([
  z.object({ expr: z.string().min(1) }),
  z.object({ nextval: id }), // 指向 sequence，序列改名时不需要改写默认值
]);

export const Column = z.object({
  id,
  kind: z.literal('column'),
  parent: id, // table
  name,
  pos: z.string(), // 展示顺序（分数索引）
  /** 引擎规范类型文本（format_type，search_path 为空时的输出），例如 `character varying(255)`、`integer[]` */
  type: z.string().min(1),
  /** 类型是 IR 中的枚举时指向它；此时 type 只记录数组维度后缀（如 `[]`），名字由枚举渲染 */
  typeRef: id.nullable().default(null),
  notNull: z.boolean().default(false),
  /** PG 18 起 NOT NULL 是带名字的约束 */
  notNullName: name.nullable().default(null),
  notNullNameMode: nameMode.default('derived'),
  default: ColumnDefault.nullable().default(null),
  identity: z
    .object({
      always: z.boolean(),
      sequenceName: name,
      sequenceNameMode: nameMode.default('derived'),
      options: SequenceOptions.prefault({}),
    })
    .nullable()
    .default(null),
  generated: z
    .object({ expr: z.string().min(1), stored: z.boolean() })
    .nullable()
    .default(null),
  collation: z.string().nullable().default(null),
  comment,
});

const constraintBase = {
  id,
  parent: id, // table
  name,
  nameMode: nameMode.default('derived'),
  comment,
};

export const PrimaryKey = z.object({
  ...constraintBase,
  kind: z.literal('primaryKey'),
  columns: z.array(id).min(1),
});

export const Unique = z.object({
  ...constraintBase,
  kind: z.literal('unique'),
  columns: z.array(id).min(1),
  nullsNotDistinct: z.boolean().default(false),
});

export const FkAction = z.enum(['noAction', 'restrict', 'cascade', 'setNull', 'setDefault']);

export const ForeignKey = z.object({
  ...constraintBase,
  kind: z.literal('foreignKey'),
  columns: z.array(id).min(1),
  refTable: id,
  refColumns: z.array(id).min(1),
  onDelete: FkAction.default('noAction'),
  onUpdate: FkAction.default('noAction'),
  match: z.enum(['simple', 'full']).default('simple'),
  deferrable: z.boolean().default(false),
  initiallyDeferred: z.boolean().default(false),
});

export const Check = z.object({
  ...constraintBase,
  kind: z.literal('check'),
  expr: z.string().min(1),
  noInherit: z.boolean().default(false),
});

export const IndexElement = z.object({
  column: id.nullable().default(null),
  expr: z.string().nullable().default(null), // column 与 expr 二选一
  desc: z.boolean().default(false),
  nullsFirst: z.boolean().nullable().default(null), // null = 默认（ASC 时 NULLS LAST，DESC 时 NULLS FIRST）
  opclass: z.string().nullable().default(null),
  collation: z.string().nullable().default(null),
});

export const Index = z.object({
  ...constraintBase,
  kind: z.literal('index'),
  unique: z.boolean().default(false),
  method: z.string().default('btree'),
  elements: z.array(IndexElement).min(1),
  include: z.array(id).default([]),
  where: z.string().nullable().default(null),
  nullsNotDistinct: z.boolean().default(false),
});

export const Extension = z.object({
  id,
  kind: z.literal('extension'),
  name,
  parent: id, // 安装到的 schema
  comment,
});

/**
 * 不透明对象：能导入、原样导出、参与 diff（按 DDL 文本），但不能可视化编辑（04-ir-design.md 1.7）。
 * early 在建表之前创建（域、类型、函数、聚合），late 在建表之后创建（视图、触发器、策略、排他约束）。
 */
export const OpaqueType = z.enum([
  'domain',
  'type',
  'function',
  'procedure',
  'aggregate',
  'view',
  'materializedView',
  'trigger',
  'policy',
  'exclusion',
]);
export const EARLY_OPAQUE: ReadonlySet<string> = new Set([
  'domain',
  'type',
  'function',
  'procedure',
  'aggregate',
]);

export const Opaque = z.object({
  id,
  kind: z.literal('opaque'),
  objType: OpaqueType,
  parent: id, // schema；触发器、策略、排他约束是所在的表
  /** 显示名；函数带参数类型以区分重载，如 `group_concat(text)` */
  name: z.string().min(1),
  /** 引擎读出的规范 DDL，按顺序执行（可含 COMMENT 等附带语句） */
  ddl: z.array(z.string().min(1)).min(1),
  /** 删除它的语句 */
  drop: z.string().min(1),
  /** 依赖的 IR 对象（表、列、类型、其他不透明对象），决定创建顺序和何时需要重建 */
  deps: z.array(id).default([]),
  /** 原库中的创建顺序（OID 顺序），依赖关系不完整时（如函数体内调用）用于排序 */
  order: z.number().default(0),
  comment,
});

export const Obj = z.discriminatedUnion('kind', [
  Extension,
  Opaque,
  Schema,
  Enum,
  Sequence,
  Table,
  Column,
  PrimaryKey,
  Unique,
  ForeignKey,
  Check,
  Index,
]);

export const Model = z.object({
  format: z.literal(FORMAT),
  dialect: z.literal('pg'),
  objects: z.record(z.string(), Obj),
});

export type Schema = z.infer<typeof Schema>;
export type Extension = z.infer<typeof Extension>;
export type Opaque = z.infer<typeof Opaque>;
export type OpaqueType = z.infer<typeof OpaqueType>;
export type Enum = z.infer<typeof Enum>;
export type SequenceOptions = z.infer<typeof SequenceOptions>;
export type Sequence = z.infer<typeof Sequence>;
export type Table = z.infer<typeof Table>;
export type ColumnDefault = z.infer<typeof ColumnDefault>;
export type Column = z.infer<typeof Column>;
export type PrimaryKey = z.infer<typeof PrimaryKey>;
export type Unique = z.infer<typeof Unique>;
export type FkAction = z.infer<typeof FkAction>;
export type ForeignKey = z.infer<typeof ForeignKey>;
export type Check = z.infer<typeof Check>;
export type IndexElement = z.infer<typeof IndexElement>;
export type Index = z.infer<typeof Index>;
export type Obj = z.infer<typeof Obj>;
export type Kind = Obj['kind'];
export type Model = z.infer<typeof Model>;
export type Constraint = PrimaryKey | Unique | ForeignKey | Check;
export type ObjOf<K extends Kind> = Extract<Obj, { kind: K }>;

export const emptyModel = (): Model => ({ format: FORMAT, dialect: 'pg', objects: {} });

export const isConstraint = (o: Obj): o is Constraint =>
  o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'foreignKey' || o.kind === 'check';
