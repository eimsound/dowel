// 画布复制粘贴的方言适配契约（ADR 0013 第 2 节）。clipboard.ts 只依赖本契约编排提取、校验、外键重连与计划编译，
// 命名空间冲突规则、推导名、类型/自增/IDENTITY/聚集索引兼容性与分区等方言细节由各方言目录下的 clipboard.ts 实现，
// 经 DialectSpec.clipboard 暴露。
// 本模块必须保持为无运行期依赖的叶子模块：方言模块在求值期继承 ClipboardNamespace，任何运行期 import 都可能引入循环求值。
import type { DialectCapabilities, IdentKind } from './dialect.ts';
import type {
  Check,
  Column,
  ColumnExt,
  ForeignKey,
  Index,
  Model,
  PartitionSpec,
  PrimaryKey,
  Table,
  TableExt,
  Unique,
} from './ir.ts';
import type { ModelIndex } from './model-index.ts';

export type ClipboardKeyKind = 'primaryKey' | 'unique' | 'check' | 'foreignKey';

/** 名字分配所需的方言标识符规则（直接传入 DialectSpec 即可） */
export interface ClipboardIdentRules {
  readonly capabilities: Pick<DialectCapabilities, 'maxIdentLength' | 'maxIdentUnit'>;
  validateIdent(name: string, kind: IdentKind): string | null;
}

/** 限定类型名改写（来源 `schema.enum` → 目标 `schema.enum`） */
export interface QualifiedTypeRename {
  fromSchema: string;
  fromName: string;
  toSchema: string;
  toName: string;
}

/** 预占一个推导名（约束 / 索引未显式命名时，mutator 会按方言规则推导名字）所需的输入 */
export interface DerivedNameInput {
  schemaId: string;
  tableId: string;
  /** 所在表的新名字 */
  tableName: string;
  /** 已映射到新列 ID 的约束 / 索引（CHECK 的 expr 已改写为新列名） */
  obj: PrimaryKey | Unique | ForeignKey | Check | Index;
  /** 新列 ID → 新列名（未知 ID 为空串） */
  columnNames(ids: readonly string[]): string[];
  /** 索引元素与 INCLUDE 列的推导名片段（表达式元素取函数名或 `expr`，重名追加序号） */
  indexElementNames(ix: Pick<Index, 'elements' | 'include'>): string[];
  /** CHECK 表达式恰好引用一个本表列时返回该列名，否则 null */
  singleCheckRef(expr: string): string | null;
}

/** 正在粘贴的一列（表粒度 / 表内粒度共用） */
export interface PastedColumnInput {
  schemaId: string;
  tableId: string;
  /** 所在表的（新）名字 */
  tableName: string;
  /** 列的新名字 */
  columnName: string;
  /** 列类型原文（供方言识别写入时会展开的伪类型，如 PG serial） */
  type?: string;
  /** 映射后的枚举类型引用 */
  typeRef?: string | null;
  /** 待提交的扩展（已是独立副本，可直接修改或替换） */
  ext: ColumnExt | undefined;
  /** 映射后是否带 default */
  hasDefault: boolean;
  /** 来源列是否 NOT NULL */
  notNull: boolean;
  /** 是否带 IDENTITY */
  hasIdentity: boolean;
}

/** 方言改名回调：from → to（报告里记为所在表上的列级改名） */
export type ClipboardRenameSink = (from: string, to: string) => void;

export interface PreparedItemColumn {
  /** 最终提交的列扩展 */
  ext: ColumnExt | undefined;
  /** 列在草稿模型上预演成功并提交后调用；created 为草稿上建出的列（含 mutator 推导出的名字） */
  commit(created: Column | undefined): void;
}

/** 表内粘贴的列级能力检查输入 */
export interface ItemColumnGuardInput {
  /** 目标表 */
  table: Table;
  /** 目标表现有列 */
  existingCols: readonly Column[];
  /** 粘贴前目标表是否已有主键 */
  hasTargetPk: boolean;
  /** 同批粘贴的主键 / 唯一约束 / 索引（来源对象，列仍为来源列 ID） */
  batchPk: PrimaryKey | undefined;
  batchUniques: readonly Unique[];
  batchIndexes: readonly Index[];
}

/** 表内粘贴时已通过检查的候选列 */
export interface PastedCandidate {
  src: Column;
  newName: string;
}

/** 从扩展中剥离“必须等主键建好后才能设置”的属性 */
export interface DeferredExt<T> {
  /** 建表 / 加列时使用的扩展（剥离后） */
  stripped: T | undefined;
}

/** 方言剪贴板适配器（DialectSpec.clipboard） */
export interface ClipboardDialect {
  /** 表 / 列等标识符是否大小写不敏感（列名映射、表达式改写、外部引用表查找） */
  readonly caseInsensitiveIdents: boolean;
  /** 按名查找目标 schema 与序列时是否大小写不敏感 */
  readonly caseInsensitiveCatalog: boolean;
  /** 显式主键名能否保留（不能时按推导名处理） */
  readonly explicitPrimaryKeyNames: boolean;

  /** 为一次粘贴建立目标模型的命名空间跟踪器（构造时应单趟扫描，冲突判定保持 O(1)） */
  createNamespace: (target: Model, targetIdx: ModelIndex, rules: ClipboardIdentRules) => ClipboardNamespace;

  /** 外键引用列类型比较标签（非枚举列；两侧标签相等视为类型一致） */
  typeLabel: (col: Column) => string;

  /** 引用列集合（已去重）是否被 tableIds 中任一张表的主键 / 唯一约束 / 唯一索引支撑 */
  isUniqueBacked: (
    targetIdx: ModelIndex,
    tableIds: readonly string[],
    refColIds: ReadonlySet<string>,
  ) => boolean;

  /** 单趟改写表达式里的限定类型名（不支持限定类型引用的方言不实现） */
  rewriteQualifiedTypeRefs?: (expr: string, renames: readonly QualifiedTypeRename[]) => string;

  /** 解析表的分区键（仅在 capabilities.partitioning 时调用） */
  partitionSpecOf?: (m: Model, table: Table) => PartitionSpec | null;

  /** 表扩展中需等主键建好后才能设置的部分；无需延后返回 null（入参为独立副本；返回 null 时不得修改入参） */
  deferTableExtUntilPk?: (ext: TableExt) => DeferredExt<TableExt> | null;

  /** 列扩展中需等主键建好后才能设置的部分；无需延后返回 null（入参为独立副本；返回 null 时不得修改入参） */
  deferColumnExtUntilPk?: (ext: ColumnExt) => DeferredExt<ColumnExt> | null;

  /** 表内粘贴的逐列能力检查（有状态，按来源顺序调用）；不允许时返回原因 */
  createItemColumnGuard?: (input: ItemColumnGuardInput) => (col: Column) => string | null;

  /** 表内粘贴生成列的额外引用限制（每轮不动点检查创建一次）；不允许时返回原因 */
  createGeneratedRefGuard?: (
    existingCols: readonly Column[],
    pasted: readonly PastedCandidate[],
  ) => (rewrittenExpr: string) => string | null;

  /** 表内粘贴主键 / 唯一约束 / 索引前的方言检查（scratch 为当前草稿模型）；不允许时返回原因 */
  checkKeyItem?: (scratch: Model, tableId: string, item: PrimaryKey | Unique | Index) => string | null;

  /** 索引查重时额外比较的方言变体（如 MySQL FULLTEXT / SPATIAL）；默认不区分 */
  indexVariant?: (ix: Index) => unknown;
}

// ───── 共用小工具（方言实现可直接复用） ─────

export const addToSetMap = (map: Map<string, Set<string>>, container: string, name: string): void => {
  let set = map.get(container);
  if (!set) {
    set = new Set();
    map.set(container, set);
  }
  set.add(name);
};

export const delFromSetMap = (map: Map<string, Set<string>>, container: string, name: string): void => {
  const set = map.get(container);
  if (!set) return;
  set.delete(name);
  if (set.size === 0) map.delete(container);
};

export const hasInSetMap = (map: Map<string, Set<string>>, container: string, name: string): boolean =>
  map.get(container)?.has(name) ?? false;

/** 清理对象的空方言扩展槽位，避免向 mutator 传入空对象 */
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

export const sameColumnSet = (actual: readonly string[], expectedSet: ReadonlySet<string>): boolean =>
  actual.length === expectedSet.size && actual.every((c) => expectedSet.has(c));

export const sameLeadingColumns = (actual: readonly string[], expectedSet: ReadonlySet<string>): boolean => {
  const k = expectedSet.size;
  if (actual.length < k) return false;
  const seen = new Set<string>();
  for (let i = 0; i < k; i++) {
    const cid = actual[i]!;
    if (!expectedSet.has(cid) || seen.has(cid)) return false;
    seen.add(cid);
  }
  return seen.size === k;
};

/** 默认的唯一性支撑判定：主键 / 唯一约束 / 无谓词且全为列元素的唯一索引，列集合完全相同 */
export const isExactUniqueBacked = (
  targetIdx: ModelIndex,
  tableIds: readonly string[],
  refColIds: ReadonlySet<string>,
): boolean => {
  for (const tid of tableIds) {
    for (const pk of targetIdx.childrenRef(tid, 'primaryKey')) {
      if (sameColumnSet(pk.columns, refColIds)) return true;
    }
    for (const u of targetIdx.childrenRef(tid, 'unique')) {
      if (sameColumnSet(u.columns, refColIds)) return true;
    }
    for (const ix of targetIdx.childrenRef(tid, 'index')) {
      if (ix.where) continue;
      if (!ix.unique) continue;
      if (ix.elements.some((e) => e.column === null)) continue;
      const cols = ix.elements.map((e) => e.column!);
      if (sameColumnSet(cols, refColIds)) return true;
    }
  }
  return false;
};

/** 默认的类型比较标签：方言规范化类型，折叠空白并转小写 */
export const normalizedTypeLabel = (normalizeType: (input: string) => string, col: Column): string =>
  normalizeType(col.type).trim().replace(/\s+/g, ' ').toLowerCase();

const textEncoder = new TextEncoder();

export const utf8ByteLen = (s: string): number => textEncoder.encode(s).length;

const stripCopySuffix = (name: string): string => name.replace(/_copy\d*$/, '');

const clipByUnit = (s: string, maxLen: number, unit: 'bytes' | 'chars'): string => {
  if (maxLen <= 0) return '';
  if (unit === 'chars') return Array.from(s).slice(0, maxLen).join('');
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const chBytes = utf8ByteLen(ch);
    if (bytes + chBytes > maxLen) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
};

const identUnitLen = (s: string, unit: 'bytes' | 'chars'): number =>
  unit === 'bytes' ? utf8ByteLen(s) : Array.from(s).length;

/**
 * 跟踪目标模型与本次粘贴已占用的全部标识符命名空间。
 * 基类负责列名（按 caseInsensitiveIdents 归一化）与冲突后缀 / 长度裁剪分配；
 * 表、类型、序列、约束与索引的命名空间规则由方言子类实现，判定须保持 O(1)（1,000 表级粘贴）。
 */
export abstract class ClipboardNamespace {
  protected readonly target: Model;
  protected readonly targetIdx: ModelIndex;
  private readonly rules: ClipboardIdentRules;
  private readonly caseInsensitive: boolean;
  private readonly colsByTable = new Map<string, Set<string>>();

  constructor(
    target: Model,
    targetIdx: ModelIndex,
    rules: ClipboardIdentRules,
    caseInsensitiveIdents: boolean,
  ) {
    this.target = target;
    this.targetIdx = targetIdx;
    this.rules = rules;
    this.caseInsensitive = caseInsensitiveIdents;
  }

  private normCol(name: string): string {
    return this.caseInsensitive ? name.toLowerCase() : name;
  }

  isColTaken(tableId: string, name: string): boolean {
    return hasInSetMap(this.colsByTable, tableId, this.normCol(name));
  }

  addColumn(tableId: string, name: string): void {
    addToSetMap(this.colsByTable, tableId, this.normCol(name));
  }

  removeColumn(tableId: string, name: string): void {
    delFromSetMap(this.colsByTable, tableId, this.normCol(name));
  }

  abstract isTableTaken(schemaId: string, name: string): boolean;
  abstract addTable(schemaId: string, name: string): void;

  isEnumTaken(_schemaId: string, _name: string): boolean {
    return false;
  }
  addEnum(_schemaId: string, _name: string): void {}

  isSequenceTaken(_schemaId: string, _name: string): boolean {
    return false;
  }
  addSequence(_schemaId: string, _name: string): void {}

  abstract isIndexTaken(schemaId: string, tableId: string, name: string): boolean;
  abstract addIndex(schemaId: string, tableId: string, name: string): void;

  abstract isKeyTaken(schemaId: string, tableId: string, kind: ClipboardKeyKind, name: string): boolean;
  abstract addKey(schemaId: string, tableId: string, kind: ClipboardKeyKind, name: string): void;

  /** 按方言推导名规则算出 mutator 将生成的名字并预占（表粒度批量规划，不经草稿模型） */
  abstract reserveDerivedName(input: DerivedNameInput): void;

  /**
   * 表粒度粘贴的一列：预占 addColumn 会推导出的附属名字（如 PG NOT NULL / IDENTITY 序列名、MSSQL 默认约束名），
   * 并返回最终列扩展；改名经 onRename 报告。
   */
  prepareTableColumn(input: PastedColumnInput, _onRename: ClipboardRenameSink): ColumnExt | undefined {
    return input.ext;
  }

  /**
   * 表内粒度粘贴的一列：返回最终列扩展，并在列预演成功提交后（commit）登记草稿模型上推导出的附属名字。
   * 预演失败时 commit 不会被调用，此前经 onRename 报告的改名由调用方回滚。
   */
  prepareItemColumn(input: PastedColumnInput, _onRename: ClipboardRenameSink): PreparedItemColumn {
    return { ext: input.ext, commit: () => {} };
  }

  /** 为一个新名做冲突后缀与方言长度裁剪；原名可用直接返回 */
  allocateName(original: string, identKind: IdentKind, isTaken: (candidate: string) => boolean): string {
    const { maxIdentLength, maxIdentUnit } = this.rules.capabilities;
    const validate = (n: string) => this.rules.validateIdent(n, identKind);

    if (
      identUnitLen(original, maxIdentUnit) <= maxIdentLength &&
      validate(original) === null &&
      !isTaken(original)
    ) {
      return original;
    }

    const stripped = stripCopySuffix(original);
    let baseRoot = stripped.length > 0 ? stripped : 'c';
    // 若原始前缀触发保留字/保留前缀校验（如 sqlite_ / dowel_），前置安全前缀避免死循环
    if (validate(`${baseRoot}_copy`) !== null) {
      baseRoot = `c_${baseRoot}`;
    }

    for (let i = 1; ; i++) {
      const suffix = i === 1 ? '_copy' : `_copy${i}`;
      const suffixLen = identUnitLen(suffix, maxIdentUnit);
      const clippedBase = clipByUnit(baseRoot, maxIdentLength - suffixLen, maxIdentUnit) || 'c';
      const candidate = `${clippedBase}${suffix}`;
      if (validate(candidate) === null && !isTaken(candidate)) {
        return candidate;
      }
    }
  }
}
