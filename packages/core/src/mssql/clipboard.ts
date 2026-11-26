// SQL Server 画布复制粘贴方言适配器：schema 级对象名与表级索引名命名空间、默认约束名、IDENTITY / 计算列与 CLUSTERED 检查。
import {
  addToSetMap,
  type ClipboardDialect,
  type ClipboardIdentRules,
  type ClipboardKeyKind,
  ClipboardNamespace,
  type ClipboardRenameSink,
  cleanExt,
  type DerivedNameInput,
  hasInSetMap,
  isExactUniqueBacked,
  type ItemColumnGuardInput,
  normalizedTypeLabel,
  type PastedColumnInput,
  type PreparedItemColumn,
} from '../clipboard-dialect.ts';
import type { Column, ColumnExt, Index, Model, PrimaryKey, Unique } from '../ir.ts';
import { childrenOf, type ModelIndex } from '../model.ts';
import { mssqlChooseName, mssqlJoinNames } from './naming.ts';
import { isMssqlPkClustered, mssqlDefaultNameOf } from './plan.ts';
import { isMssqlIdentityEligibleType, mssqlNormalizeType } from './types.ts';

/** 去掉列扩展上的默认约束名（交给 mutator 推导） */
const stripDefaultName = (ext: ColumnExt | undefined): ColumnExt | undefined =>
  cleanExt({
    ...ext,
    mssql: { ...ext?.mssql, defaultName: undefined, defaultNameMode: undefined },
  } as Record<string, unknown>) as ColumnExt | undefined;

/**
 * SQL Server 命名空间（大小写不敏感，构造时单趟扫描目标模型）：
 * - obj：每个 schema 的 sys.objects 名字（表、序列、PK / UQ / FK / CK、默认约束、不透明对象）
 * - idx：每张表的 sys.indexes 名字（PK / UQ / 索引）
 */
class MssqlClipboardNamespace extends ClipboardNamespace {
  private readonly obj = new Map<string, Set<string>>();
  private readonly idx = new Map<string, Set<string>>();

  constructor(target: Model, targetIdx: ModelIndex, rules: ClipboardIdentRules) {
    super(target, targetIdx, rules, true);
    const tableSchema = new Map<string, string>();
    const tableName = new Map<string, string>();
    for (const t of targetIdx.allRef('table')) {
      tableSchema.set(t.id, t.parent);
      tableName.set(t.id, t.name);
    }
    for (const o of Object.values(target.objects)) {
      const low = o.name.toLowerCase();
      if (o.kind === 'table' || o.kind === 'sequence') {
        addToSetMap(this.obj, o.parent, low);
      } else if (o.kind === 'primaryKey' || o.kind === 'unique') {
        const sch = tableSchema.get(o.parent);
        if (sch) addToSetMap(this.obj, sch, low);
        addToSetMap(this.idx, o.parent, low);
      } else if (o.kind === 'foreignKey' || o.kind === 'check') {
        const sch = tableSchema.get(o.parent);
        if (sch) addToSetMap(this.obj, sch, low);
      } else if (o.kind === 'index') {
        addToSetMap(this.idx, o.parent, low);
      } else if (o.kind === 'column' && o.default) {
        const sch = tableSchema.get(o.parent);
        const tname = tableName.get(o.parent);
        if (sch && tname) {
          addToSetMap(this.obj, sch, mssqlDefaultNameOf(o, tname).toLowerCase());
        }
      } else if (o.kind === 'opaque') {
        const sch = tableSchema.has(o.parent) ? tableSchema.get(o.parent) : o.parent;
        if (sch) addToSetMap(this.obj, sch, low);
      }
    }
  }

  isTableTaken(schemaId: string, name: string): boolean {
    return hasInSetMap(this.obj, schemaId, name.toLowerCase());
  }

  addTable(schemaId: string, name: string): void {
    addToSetMap(this.obj, schemaId, name.toLowerCase());
  }

  override isSequenceTaken(schemaId: string, name: string): boolean {
    return hasInSetMap(this.obj, schemaId, name.toLowerCase());
  }

  override addSequence(schemaId: string, name: string): void {
    addToSetMap(this.obj, schemaId, name.toLowerCase());
  }

  /** 默认约束 / FK / CHECK 只占 schema 级对象名 */
  private isDefaultTaken(schemaId: string, name: string): boolean {
    return hasInSetMap(this.obj, schemaId, name.toLowerCase());
  }

  private addDefault(schemaId: string, name: string): void {
    addToSetMap(this.obj, schemaId, name.toLowerCase());
  }

  isIndexTaken(schemaId: string, tableId: string, name: string): boolean {
    const low = name.toLowerCase();
    return hasInSetMap(this.obj, schemaId, low) || hasInSetMap(this.idx, tableId, low);
  }

  addIndex(_schemaId: string, tableId: string, name: string): void {
    addToSetMap(this.idx, tableId, name.toLowerCase());
  }

  isKeyTaken(schemaId: string, tableId: string, _kind: ClipboardKeyKind, name: string): boolean {
    const low = name.toLowerCase();
    return hasInSetMap(this.obj, schemaId, low) || hasInSetMap(this.idx, tableId, low);
  }

  addKey(schemaId: string, tableId: string, kind: ClipboardKeyKind, name: string): void {
    const low = name.toLowerCase();
    addToSetMap(this.obj, schemaId, low);
    if (kind === 'primaryKey' || kind === 'unique') {
      addToSetMap(this.idx, tableId, low);
    }
  }

  reserveDerivedName(input: DerivedNameInput): void {
    const { schemaId, tableId, tableName, obj } = input;
    switch (obj.kind) {
      case 'primaryKey':
        this.addKey(
          schemaId,
          tableId,
          'primaryKey',
          mssqlChooseName('PK', tableName, null, (n) => this.isKeyTaken(schemaId, tableId, 'primaryKey', n)),
        );
        break;
      case 'unique':
        this.addKey(
          schemaId,
          tableId,
          'unique',
          mssqlChooseName('UQ', tableName, mssqlJoinNames(input.columnNames(obj.columns)), (n) =>
            this.isKeyTaken(schemaId, tableId, 'unique', n),
          ),
        );
        break;
      case 'foreignKey':
        this.addKey(
          schemaId,
          tableId,
          'foreignKey',
          mssqlChooseName('FK', tableName, mssqlJoinNames(input.columnNames(obj.columns)), (n) =>
            this.isDefaultTaken(schemaId, n),
          ),
        );
        break;
      case 'check':
        this.addKey(
          schemaId,
          tableId,
          'check',
          mssqlChooseName('CK', tableName, input.singleCheckRef(obj.expr), (n) =>
            this.isDefaultTaken(schemaId, n),
          ),
        );
        break;
      case 'index':
        this.addIndex(
          schemaId,
          tableId,
          mssqlChooseName('IX', tableName, mssqlJoinNames(input.indexElementNames(obj)), (n) =>
            this.isIndexTaken(schemaId, tableId, n),
          ),
        );
        break;
    }
  }

  /** 表粒度：显式默认约束名做冲突后缀并预占；推导名按 DF_<表>_<列> 规则预占（addColumn 时由 mutator 重算） */
  override prepareTableColumn(
    input: PastedColumnInput,
    onRename: ClipboardRenameSink,
  ): ColumnExt | undefined {
    const { ext } = input;
    if (input.hasDefault) {
      const mssqlExt = ext?.mssql;
      if (mssqlExt?.defaultNameMode === 'explicit' && mssqlExt.defaultName) {
        const newDfName = this.allocateName(mssqlExt.defaultName, 'constraint', (n) =>
          this.isDefaultTaken(input.schemaId, n),
        );
        this.addDefault(input.schemaId, newDfName);
        if (newDfName !== mssqlExt.defaultName) onRename(mssqlExt.defaultName, newDfName);
        return { ...ext, mssql: { ...mssqlExt, defaultName: newDfName, defaultNameMode: 'explicit' } };
      }
      const derivedDf = mssqlChooseName('DF', input.tableName, input.columnName, (n) =>
        this.isDefaultTaken(input.schemaId, n),
      );
      this.addDefault(input.schemaId, derivedDf);
      return ext?.mssql ? stripDefaultName(ext) : ext;
    }
    return ext?.mssql ? stripDefaultName(ext) : ext;
  }

  /** 表内粒度：显式默认约束名做冲突后缀，预演成功后再登记；推导名从草稿上建出的列读取 */
  override prepareItemColumn(input: PastedColumnInput, onRename: ClipboardRenameSink): PreparedItemColumn {
    let { ext } = input;
    let reservedDfName: string | null = null;
    if (input.hasDefault) {
      const mssqlExt = ext?.mssql;
      if (mssqlExt?.defaultNameMode === 'explicit' && mssqlExt.defaultName) {
        const newDfName = this.allocateName(mssqlExt.defaultName, 'constraint', (n) =>
          this.isDefaultTaken(input.schemaId, n),
        );
        reservedDfName = newDfName;
        if (newDfName !== mssqlExt.defaultName) onRename(mssqlExt.defaultName, newDfName);
        ext = { ...ext, mssql: { ...mssqlExt, defaultName: newDfName, defaultNameMode: 'explicit' } };
      } else if (ext?.mssql) {
        ext = stripDefaultName(ext);
      }
    } else if (ext?.mssql) {
      ext = stripDefaultName(ext);
    }
    return {
      ext,
      commit: (created) => {
        if (reservedDfName) this.addDefault(input.schemaId, reservedDfName);
        if (created?.default && !reservedDfName) {
          this.addDefault(input.schemaId, mssqlDefaultNameOf(created, input.tableName));
        }
      },
    };
  }
}

/** 表内粘贴的逐列检查：每表至多一个 IDENTITY 列、IDENTITY 列类型与可空性、非 PERSISTED 计算列不能 NOT NULL */
const createItemColumnGuard = (input: ItemColumnGuardInput) => {
  let hasIdentity = input.existingCols.some((c) => Boolean(c.ext?.mssql?.identity));
  return (sc: Column): string | null => {
    if (sc.ext?.mssql?.identity) {
      if (hasIdentity) return 'SQL Server 每张表最多只能有一个 IDENTITY 列';
      if (!isMssqlIdentityEligibleType(sc.type) || !sc.notNull || sc.default || sc.generated) {
        return `列 ${sc.name} 不满足 MSSQL IDENTITY 条件`;
      }
      hasIdentity = true;
    }
    if (sc.generated && !sc.generated.stored && sc.notNull) {
      return 'SQL Server 非 PERSISTED 计算列不能声明 NOT NULL';
    }
    return null;
  };
};

const hasClusteredOnTable = (m: Model, tableId: string): boolean => {
  for (const pk of childrenOf(m, tableId, 'primaryKey')) {
    if (isMssqlPkClustered(m, pk)) return true;
  }
  for (const u of childrenOf(m, tableId, 'unique')) {
    if (u.ext?.mssql?.clustered === true) return true;
  }
  for (const ix of childrenOf(m, tableId, 'index')) {
    if (ix.ext?.mssql?.clustered === true) return true;
  }
  return false;
};

/** 每张表至多一个 CLUSTERED 约束或索引 */
const checkKeyItem = (scratch: Model, tableId: string, item: PrimaryKey | Unique | Index): string | null =>
  item.ext?.mssql?.clustered === true && hasClusteredOnTable(scratch, tableId)
    ? '目标表已有 CLUSTERED 约束或索引'
    : null;

export const mssqlClipboard: ClipboardDialect = {
  caseInsensitiveIdents: true,
  caseInsensitiveCatalog: true,
  explicitPrimaryKeyNames: true,
  createNamespace: (target, targetIdx, rules) => new MssqlClipboardNamespace(target, targetIdx, rules),
  typeLabel: (col) => normalizedTypeLabel(mssqlNormalizeType, col),
  isUniqueBacked: isExactUniqueBacked,
  createItemColumnGuard,
  checkKeyItem,
};
