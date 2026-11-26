// MySQL 画布复制粘贴方言适配器：库级表名 / 约束名与表级索引名命名空间、unsigned 类型比较、前导列唯一支撑与 AUTO_INCREMENT 检查。
import {
  addToSetMap,
  type ClipboardDialect,
  type ClipboardIdentRules,
  type ClipboardKeyKind,
  ClipboardNamespace,
  type DerivedNameInput,
  hasInSetMap,
  type ItemColumnGuardInput,
  type PastedCandidate,
  sameLeadingColumns,
} from '../clipboard-dialect.ts';
import type { Column, Index, Model } from '../ir.ts';
import type { ModelIndex } from '../model.ts';
import { mysqlChooseName, mysqlJoinNames } from './naming.ts';
import { mysqlExprReferences } from './quote.ts';
import { isMysqlAutoIncrementType, splitMysqlTypeModifiers } from './types.ts';

/** InnoDB 中能支撑外键 / AUTO_INCREMENT 的索引不能是 FULLTEXT / SPATIAL */
const isBtreeLikeIndex = (ix: Index): boolean => {
  const idxType = (ix.ext?.mysql?.indexType ?? ix.method).toUpperCase();
  return idxType !== 'FULLTEXT' && idxType !== 'SPATIAL';
};

/**
 * MySQL 命名空间（大小写不敏感，构造时单趟扫描目标模型）：
 * - rel：库内表与视图名
 * - schemaCon：库级外键 / CHECK 约束名
 * - idx：每张表上的索引名（唯一约束、索引、外键隐式索引；PRIMARY 保留）
 * 主键名恒为 PRIMARY，不占用也不预占任何名字。
 */
class MysqlClipboardNamespace extends ClipboardNamespace {
  private readonly rel = new Set<string>();
  private readonly schemaCon = new Set<string>();
  private readonly idx = new Map<string, Set<string>>();

  constructor(target: Model, targetIdx: ModelIndex, rules: ClipboardIdentRules) {
    super(target, targetIdx, rules, true);
    for (const o of Object.values(target.objects)) {
      const low = o.name.toLowerCase();
      if (o.kind === 'table' || (o.kind === 'opaque' && o.objType === 'view')) {
        this.rel.add(low);
      } else if (o.kind === 'unique' || o.kind === 'index') {
        addToSetMap(this.idx, o.parent, low);
      } else if (o.kind === 'foreignKey') {
        this.schemaCon.add(low);
        addToSetMap(this.idx, o.parent, low);
      } else if (o.kind === 'check') {
        this.schemaCon.add(low);
      }
    }
  }

  isTableTaken(_schemaId: string, name: string): boolean {
    return this.rel.has(name.toLowerCase());
  }

  addTable(_schemaId: string, name: string): void {
    this.rel.add(name.toLowerCase());
  }

  isIndexTaken(_schemaId: string, tableId: string, name: string): boolean {
    const low = name.toLowerCase();
    return low === 'primary' || hasInSetMap(this.idx, tableId, low);
  }

  addIndex(_schemaId: string, tableId: string, name: string): void {
    addToSetMap(this.idx, tableId, name.toLowerCase());
  }

  isKeyTaken(_schemaId: string, tableId: string, kind: ClipboardKeyKind, name: string): boolean {
    const low = name.toLowerCase();
    if (kind === 'primaryKey') return false;
    if (kind === 'unique') return low === 'primary' || hasInSetMap(this.idx, tableId, low);
    if (kind === 'check') return this.schemaCon.has(low);
    return low === 'primary' || this.schemaCon.has(low) || hasInSetMap(this.idx, tableId, low);
  }

  addKey(_schemaId: string, tableId: string, kind: ClipboardKeyKind, name: string): void {
    if (kind === 'primaryKey') return;
    const low = name.toLowerCase();
    if (kind === 'unique') {
      addToSetMap(this.idx, tableId, low);
    } else if (kind === 'check') {
      this.schemaCon.add(low);
    } else {
      this.schemaCon.add(low);
      addToSetMap(this.idx, tableId, low);
    }
  }

  reserveDerivedName(input: DerivedNameInput): void {
    const { schemaId, tableId, tableName, obj } = input;
    switch (obj.kind) {
      case 'primaryKey':
        break;
      case 'unique':
        this.addKey(
          schemaId,
          tableId,
          'unique',
          mysqlChooseName(tableName, mysqlJoinNames(input.columnNames(obj.columns)), 'key', (n) =>
            this.isKeyTaken(schemaId, tableId, 'unique', n),
          ),
        );
        break;
      case 'foreignKey':
        this.addKey(
          schemaId,
          tableId,
          'foreignKey',
          mysqlChooseName(tableName, mysqlJoinNames(input.columnNames(obj.columns)), 'fkey', (n) =>
            this.isKeyTaken(schemaId, tableId, 'foreignKey', n),
          ),
        );
        break;
      case 'check':
        this.addKey(
          schemaId,
          tableId,
          'check',
          mysqlChooseName(tableName, input.singleCheckRef(obj.expr), 'check', (n) =>
            this.isKeyTaken(schemaId, tableId, 'check', n),
          ),
        );
        break;
      case 'index':
        this.addIndex(
          schemaId,
          tableId,
          mysqlChooseName(tableName, mysqlJoinNames(input.indexElementNames(obj)), 'idx', (n) =>
            this.isIndexTaken(schemaId, tableId, n),
          ),
        );
        break;
    }
  }
}

/** 外键引用列类型比较：剥离 unsigned / zerofill 修饰后与列级 unsigned 标记合并 */
const typeLabel = (col: Column): string => {
  const split = splitMysqlTypeModifiers(col.type);
  const unsigned = Boolean(col.ext?.mysql?.unsigned || split.unsigned || col.ext?.mysql?.zerofill);
  return `${split.baseType}${unsigned ? ' unsigned' : ''}`.trim().replace(/\s+/g, ' ').toLowerCase();
};

/** InnoDB 外键只要求被引用列是某个（非 FULLTEXT / SPATIAL）索引的前导列 */
const isUniqueBacked = (
  targetIdx: ModelIndex,
  tableIds: readonly string[],
  refColIds: ReadonlySet<string>,
): boolean => {
  for (const tid of tableIds) {
    for (const pk of targetIdx.childrenRef(tid, 'primaryKey')) {
      if (sameLeadingColumns(pk.columns, refColIds)) return true;
    }
    for (const u of targetIdx.childrenRef(tid, 'unique')) {
      if (sameLeadingColumns(u.columns, refColIds)) return true;
    }
    for (const ix of targetIdx.childrenRef(tid, 'index')) {
      if (ix.where) continue;
      if (!isBtreeLikeIndex(ix)) continue;
      if (ix.elements.length < refColIds.size) continue;
      const leadCols: string[] = [];
      let ok = true;
      for (let i = 0; i < refColIds.size; i++) {
        const c = ix.elements[i]?.column;
        if (!c) {
          ok = false;
          break;
        }
        leadCols.push(c);
      }
      if (ok && sameLeadingColumns(leadCols, refColIds)) return true;
    }
  }
  return false;
};

/** 表内粘贴的逐列检查：每表至多一列 AUTO_INCREMENT，且须同批带上以其为首列的键 */
const createItemColumnGuard = (input: ItemColumnGuardInput) => {
  const { hasTargetPk, batchPk, batchUniques, batchIndexes } = input;
  let hasAutoInc = input.existingCols.some((c) => Boolean(c.ext?.mysql?.autoIncrement));
  const hasCoveringKeyInBatch = (srcColId: string): boolean => {
    if (!hasTargetPk && batchPk && batchPk.columns[0] === srcColId) return true;
    if (batchUniques.some((u) => u.columns[0] === srcColId)) return true;
    return batchIndexes.some((ix) => isBtreeLikeIndex(ix) && ix.elements[0]?.column === srcColId);
  };
  return (sc: Column): string | null => {
    if (!sc.ext?.mysql?.autoIncrement) return null;
    if (hasAutoInc) return 'MySQL 每张表最多只能有一列 AUTO_INCREMENT';
    if (!isMysqlAutoIncrementType(sc.type) || sc.generated || sc.default || !sc.notNull) {
      return `列 ${sc.name} 不满足 AUTO_INCREMENT 条件`;
    }
    if (!hasCoveringKeyInBatch(sc.id)) return 'AUTO_INCREMENT 列需同批粘贴以其为首列的主键、唯一约束或索引';
    hasAutoInc = true;
    return null;
  };
};

/** 生成列不能引用 AUTO_INCREMENT 列（目标表已有的与本批存活的） */
const createGeneratedRefGuard = (existingCols: readonly Column[], pasted: readonly PastedCandidate[]) => {
  const autoIncNames = new Set<string>(
    existingCols.filter((c) => c.ext?.mysql?.autoIncrement).map((c) => c.name.toLowerCase()),
  );
  for (const c of pasted) {
    if (c.src.ext?.mysql?.autoIncrement) autoIncNames.add(c.newName.toLowerCase());
  }
  return (expr: string): string | null =>
    [...autoIncNames].some((ai) => mysqlExprReferences(expr, ai))
      ? 'MySQL 生成列不能引用 AUTO_INCREMENT 列'
      : null;
};

export const mysqlClipboard: ClipboardDialect = {
  caseInsensitiveIdents: true,
  caseInsensitiveCatalog: false,
  explicitPrimaryKeyNames: false,
  createNamespace: (target, targetIdx, rules) => new MysqlClipboardNamespace(target, targetIdx, rules),
  typeLabel,
  isUniqueBacked,
  createItemColumnGuard,
  createGeneratedRefGuard,
  indexVariant: (ix) => ix.ext?.mysql?.indexType,
};
