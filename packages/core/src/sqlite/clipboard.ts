// SQLite 画布复制粘贴方言适配器：库级表 / 索引命名空间、表级约束名、WITHOUT ROWID / AUTOINCREMENT 延后与 STRICT 类型检查。
import {
  addToSetMap,
  type ClipboardDialect,
  type ClipboardIdentRules,
  type ClipboardKeyKind,
  ClipboardNamespace,
  cleanExt,
  type DerivedNameInput,
  hasInSetMap,
  isExactUniqueBacked,
  type ItemColumnGuardInput,
  normalizedTypeLabel,
} from '../clipboard-dialect.ts';
import type { Column, ColumnExt, Model, TableExt } from '../ir.ts';
import type { ModelIndex } from '../model.ts';
import { sqliteChooseName, sqliteJoinNames } from './naming.ts';
import { SQLITE_STRICT_TYPES, sqliteNormalizeType } from './types.ts';

/**
 * SQLite 命名空间（大小写不敏感，构造时单趟扫描目标模型）：
 * - rel：库内表 / 索引 / 视图等共享的名字
 * - con：每张表上的约束名
 */
class SqliteClipboardNamespace extends ClipboardNamespace {
  private readonly rel = new Set<string>();
  private readonly con = new Map<string, Set<string>>();

  constructor(target: Model, targetIdx: ModelIndex, rules: ClipboardIdentRules) {
    super(target, targetIdx, rules, true);
    for (const o of Object.values(target.objects)) {
      const low = o.name.toLowerCase();
      if (o.kind === 'table' || o.kind === 'index' || o.kind === 'opaque') {
        this.rel.add(low);
      } else if (
        o.kind === 'primaryKey' ||
        o.kind === 'unique' ||
        o.kind === 'check' ||
        o.kind === 'foreignKey'
      ) {
        addToSetMap(this.con, o.parent, low);
      }
    }
  }

  isTableTaken(_schemaId: string, name: string): boolean {
    return this.rel.has(name.toLowerCase());
  }

  addTable(_schemaId: string, name: string): void {
    this.rel.add(name.toLowerCase());
  }

  isIndexTaken(_schemaId: string, _tableId: string, name: string): boolean {
    return this.rel.has(name.toLowerCase());
  }

  addIndex(_schemaId: string, _tableId: string, name: string): void {
    this.rel.add(name.toLowerCase());
  }

  isKeyTaken(_schemaId: string, tableId: string, _kind: ClipboardKeyKind, name: string): boolean {
    return hasInSetMap(this.con, tableId, name.toLowerCase());
  }

  addKey(_schemaId: string, tableId: string, _kind: ClipboardKeyKind, name: string): void {
    addToSetMap(this.con, tableId, name.toLowerCase());
  }

  reserveDerivedName(input: DerivedNameInput): void {
    const { schemaId, tableId, tableName, obj } = input;
    switch (obj.kind) {
      case 'primaryKey':
        this.addKey(
          schemaId,
          tableId,
          'primaryKey',
          sqliteChooseName(tableName, null, 'pkey', (n) =>
            this.isKeyTaken(schemaId, tableId, 'primaryKey', n),
          ),
        );
        break;
      case 'unique':
        this.addKey(
          schemaId,
          tableId,
          'unique',
          sqliteChooseName(tableName, sqliteJoinNames(input.columnNames(obj.columns)), 'key', (n) =>
            this.isKeyTaken(schemaId, tableId, 'unique', n),
          ),
        );
        break;
      case 'foreignKey':
        this.addKey(
          schemaId,
          tableId,
          'foreignKey',
          sqliteChooseName(tableName, sqliteJoinNames(input.columnNames(obj.columns)), 'fkey', (n) =>
            this.isKeyTaken(schemaId, tableId, 'foreignKey', n),
          ),
        );
        break;
      case 'check':
        this.addKey(
          schemaId,
          tableId,
          'check',
          sqliteChooseName(tableName, input.singleCheckRef(obj.expr), 'check', (n) =>
            this.isKeyTaken(schemaId, tableId, 'check', n),
          ),
        );
        break;
      case 'index':
        this.addIndex(
          schemaId,
          tableId,
          sqliteChooseName(tableName, sqliteJoinNames(input.indexElementNames(obj)), 'idx', (n) =>
            this.isIndexTaken(schemaId, tableId, n),
          ),
        );
        break;
    }
  }
}

/** WITHOUT ROWID 必须等主键建好后才能设置 */
const deferTableExtUntilPk = (ext: TableExt) => {
  if (!ext.sqlite?.withoutRowid) return null;
  return {
    stripped: cleanExt({
      ...ext,
      sqlite: { ...ext.sqlite, withoutRowid: undefined },
    } as Record<string, unknown>) as TableExt | undefined,
  };
};

/** AUTOINCREMENT 必须等对应的单列主键建好后才能设置 */
const deferColumnExtUntilPk = (ext: ColumnExt) => {
  if (!ext.sqlite?.autoincrement) return null;
  return {
    stripped: cleanExt({
      ...ext,
      sqlite: { ...ext.sqlite, autoincrement: undefined },
    } as Record<string, unknown>) as ColumnExt | undefined,
  };
};

/** 表内粘贴的逐列检查：STRICT 表列类型与 AUTOINCREMENT 约束 */
const createItemColumnGuard = (input: ItemColumnGuardInput) => {
  const { table, hasTargetPk, batchPk } = input;
  let hasAutoInc = input.existingCols.some((c) => Boolean(c.ext?.sqlite?.autoincrement));
  return (sc: Column): string | null => {
    if (table.ext?.sqlite?.strict) {
      const normalized = sqliteNormalizeType(sc.type);
      if (!normalized) return 'STRICT 表的列必须声明类型';
      if (!SQLITE_STRICT_TYPES.has(normalized)) {
        return `STRICT 表不支持列类型 ${sc.type}`;
      }
    }
    if (sc.ext?.sqlite?.autoincrement) {
      if (table.ext?.sqlite?.withoutRowid) return 'WITHOUT ROWID 表不能使用 AUTOINCREMENT';
      if (sc.type.trim().toUpperCase() !== 'INTEGER') return 'AUTOINCREMENT 只能用于 INTEGER 类型列';
      if (hasAutoInc || hasTargetPk) return '目标表已有主键或 AUTOINCREMENT 列';
      if (!batchPk || batchPk.columns.length !== 1 || batchPk.columns[0] !== sc.id) {
        return 'AUTOINCREMENT 列必须同批粘贴对应的单列主键';
      }
      hasAutoInc = true;
    }
    return null;
  };
};

export const sqliteClipboard: ClipboardDialect = {
  caseInsensitiveIdents: true,
  caseInsensitiveCatalog: false,
  explicitPrimaryKeyNames: true,
  createNamespace: (target, targetIdx, rules) => new SqliteClipboardNamespace(target, targetIdx, rules),
  typeLabel: (col) => normalizedTypeLabel(sqliteNormalizeType, col),
  isUniqueBacked: isExactUniqueBacked,
  deferTableExtUntilPk,
  deferColumnExtUntilPk,
  createItemColumnGuard,
};
