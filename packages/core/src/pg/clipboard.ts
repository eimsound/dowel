// PostgreSQL 画布复制粘贴方言适配器：rel / type / con 命名空间（含分区祖先下传约束）、推导名、限定枚举名改写与分区键解析。
import {
  addToSetMap,
  type ClipboardDialect,
  type ClipboardIdentRules,
  type ClipboardKeyKind,
  ClipboardNamespace,
  type DerivedNameInput,
  hasInSetMap,
  isExactUniqueBacked,
  normalizedTypeLabel,
  type PastedColumnInput,
  type PreparedItemColumn,
  type QualifiedTypeRename,
} from '../clipboard-dialect.ts';
import type { Model } from '../ir.ts';
import { type ModelIndex, partitionAncestors } from '../model.ts';
import { tokenize } from './expr.ts';
import { chooseName, joinNames } from './naming.ts';
import { resolvePartitionBy } from './partition.ts';
import { ident } from './quote.ts';
import { parsePgSerialType } from './serial.ts';
import { normalizeType } from './types.ts';

/**
 * PG 命名空间：目标模型的占用经 targetIdx 的 PG 索引 O(1) 查询，本次粘贴新占用的名字记在本地集合（区分大小写）。
 * - rel：schema 内表 / 序列 / 索引 / 主键 / 唯一约束（含 IDENTITY 序列）
 * - type：schema 内枚举与表的行类型
 * - con：表上全部约束名（含 NOT NULL）；propCon：会下传到分区子表的约束名（CHECK / FK / NOT NULL）
 */
class PgClipboardNamespace extends ClipboardNamespace {
  private readonly rel = new Map<string, Set<string>>();
  private readonly type = new Map<string, Set<string>>();
  private readonly con = new Map<string, Set<string>>();
  private readonly propCon = new Map<string, Set<string>>();

  constructor(target: Model, targetIdx: ModelIndex, rules: ClipboardIdentRules) {
    super(target, targetIdx, rules, false);
  }

  isTableTaken(schemaId: string, name: string): boolean {
    return (
      hasInSetMap(this.rel, schemaId, name) ||
      hasInSetMap(this.type, schemaId, name) ||
      this.targetIdx.isPgRelTaken(schemaId, name, '') ||
      this.targetIdx.isPgTypeTaken(schemaId, name, '')
    );
  }

  addTable(schemaId: string, name: string): void {
    addToSetMap(this.rel, schemaId, name);
    addToSetMap(this.type, schemaId, name);
  }

  override isEnumTaken(schemaId: string, name: string): boolean {
    return hasInSetMap(this.type, schemaId, name) || this.targetIdx.isPgTypeTaken(schemaId, name, '');
  }

  override addEnum(schemaId: string, name: string): void {
    addToSetMap(this.type, schemaId, name);
  }

  override isSequenceTaken(schemaId: string, name: string): boolean {
    return this.isRelTaken(schemaId, name);
  }

  override addSequence(schemaId: string, name: string): void {
    this.addRel(schemaId, name);
  }

  private isRelTaken(schemaId: string, name: string): boolean {
    return hasInSetMap(this.rel, schemaId, name) || this.targetIdx.isPgRelTaken(schemaId, name, '');
  }

  private addRel(schemaId: string, name: string): void {
    addToSetMap(this.rel, schemaId, name);
  }

  private isConTaken(tableId: string, name: string, propagates: boolean): boolean {
    if (hasInSetMap(this.con, tableId, name)) return true;
    if (propagates) {
      return this.targetIdx.isPgConTaken(tableId, name, '');
    }
    // 非继承约束（PK / UNIQUE）仅检查本表约束、本表列 NOT NULL 及祖先下传的 CHECK / FK / NOT NULL
    for (const o of this.targetIdx.allChildrenOf(tableId)) {
      if (o.kind === 'column') {
        if (o.notNull && o.notNullName === name) return true;
      } else if (
        (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'foreignKey') &&
        o.name === name
      ) {
        return true;
      }
    }
    if (tableId in this.target.objects) {
      for (const anc of partitionAncestors(this.target, tableId)) {
        for (const c of this.targetIdx.childrenRef(anc.id, 'column')) {
          if (c.notNull && c.notNullName === name) return true;
        }
        for (const ck of this.targetIdx.childrenRef(anc.id, 'check')) {
          if (ck.name === name) return true;
        }
        for (const fk of this.targetIdx.childrenRef(anc.id, 'foreignKey')) {
          if (fk.name === name) return true;
        }
      }
    }
    return false;
  }

  private addNotNull(tableId: string, name: string): void {
    addToSetMap(this.con, tableId, name);
    addToSetMap(this.propCon, tableId, name);
  }

  isIndexTaken(schemaId: string, _tableId: string, name: string): boolean {
    return this.isRelTaken(schemaId, name);
  }

  addIndex(schemaId: string, _tableId: string, name: string): void {
    this.addRel(schemaId, name);
  }

  isKeyTaken(schemaId: string, tableId: string, kind: ClipboardKeyKind, name: string): boolean {
    const propagates = kind === 'check' || kind === 'foreignKey';
    if (this.isConTaken(tableId, name, propagates)) return true;
    return (kind === 'primaryKey' || kind === 'unique') && this.isRelTaken(schemaId, name);
  }

  addKey(schemaId: string, tableId: string, kind: ClipboardKeyKind, name: string): void {
    addToSetMap(this.con, tableId, name);
    if (kind === 'primaryKey' || kind === 'unique') {
      addToSetMap(this.rel, schemaId, name);
    } else {
      addToSetMap(this.propCon, tableId, name);
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
          chooseName(tableName, null, 'pkey', (n) => this.isKeyTaken(schemaId, tableId, 'primaryKey', n)),
        );
        break;
      case 'unique':
        this.addKey(
          schemaId,
          tableId,
          'unique',
          chooseName(tableName, joinNames(input.columnNames(obj.columns)), 'key', (n) =>
            this.isKeyTaken(schemaId, tableId, 'unique', n),
          ),
        );
        break;
      case 'foreignKey':
        this.addKey(
          schemaId,
          tableId,
          'foreignKey',
          chooseName(tableName, joinNames(input.columnNames(obj.columns)), 'fkey', (n) =>
            this.isKeyTaken(schemaId, tableId, 'foreignKey', n),
          ),
        );
        break;
      case 'check':
        this.addKey(
          schemaId,
          tableId,
          'check',
          chooseName(tableName, input.singleCheckRef(obj.expr), 'check', (n) =>
            this.isKeyTaken(schemaId, tableId, 'check', n),
          ),
        );
        break;
      case 'index':
        this.addIndex(
          schemaId,
          tableId,
          chooseName(tableName, joinNames(input.indexElementNames(obj)), 'idx', (n) =>
            this.isIndexTaken(schemaId, tableId, n),
          ),
        );
        break;
    }
  }

  /** addColumn 会推导 NOT NULL 约束名与 IDENTITY / serial 序列名，同步预占 */
  override prepareTableColumn(input: PastedColumnInput): PastedColumnInput['ext'] {
    const isSerial = !input.typeRef && input.type !== undefined && parsePgSerialType(input.type) !== null;
    if (input.notNull || input.hasIdentity || isSerial) {
      const nnName = chooseName(input.tableName, input.columnName, 'not_null', (n) =>
        this.isConTaken(input.tableId, n, true),
      );
      this.addNotNull(input.tableId, nnName);
    }
    if (input.hasIdentity || isSerial) {
      const seqName = chooseName(input.tableName, input.columnName, 'seq', (n) =>
        this.isRelTaken(input.schemaId, n),
      );
      this.addRel(input.schemaId, seqName);
    }
    return input.ext;
  }

  /** 预演成功后登记草稿上推导出的 NOT NULL 约束名与 IDENTITY 序列名 */
  override prepareItemColumn(input: PastedColumnInput): PreparedItemColumn {
    return {
      ext: input.ext,
      commit: (created) => {
        if (!created) return;
        if (created.notNull && created.notNullName) this.addNotNull(input.tableId, created.notNullName);
        if (created.identity?.sequenceName) this.addRel(input.schemaId, created.identity.sequenceName);
      },
    };
  }
}

/** 单趟改写表达式里的限定枚举名 `schema.enum` */
const rewriteQualifiedTypeRefs = (expr: string, renames: readonly QualifiedTypeRename[]): string => {
  const effective = renames.filter((r) => r.fromSchema !== r.toSchema || r.fromName !== r.toName);
  if (effective.length === 0) return expr;
  const tokens = tokenize(expr);
  const bySchema = new Map<string, Map<string, { toSchema: string; toName: string }>>();
  for (const r of effective) {
    let inner = bySchema.get(r.fromSchema);
    if (!inner) {
      inner = new Map();
      bySchema.set(r.fromSchema, inner);
    }
    inner.set(r.fromName, { toSchema: r.toSchema, toName: r.toName });
  }
  let out = expr;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t0 = tokens[i];
    if (!t0 || (t0.kind !== 'ident' && t0.kind !== 'qident')) continue;
    if (tokens[i + 1]?.text !== '.') continue;
    const t2 = tokens[i + 2];
    if (!t2 || (t2.kind !== 'ident' && t2.kind !== 'qident')) continue;
    const target = bySchema.get(t0.text)?.get(t2.text);
    if (!target) continue;
    out = `${out.slice(0, t0.start)}${ident(target.toSchema)}.${ident(target.toName)}${out.slice(t2.end)}`;
  }
  return out;
};

export const pgClipboard: ClipboardDialect = {
  caseInsensitiveIdents: false,
  caseInsensitiveCatalog: false,
  explicitPrimaryKeyNames: true,
  createNamespace: (target, targetIdx, rules) => new PgClipboardNamespace(target, targetIdx, rules),
  typeLabel: (col) => normalizedTypeLabel(normalizeType, col),
  isUniqueBacked: isExactUniqueBacked,
  rewriteQualifiedTypeRefs,
  partitionSpecOf: (m, table) => resolvePartitionBy(m, table),
};
