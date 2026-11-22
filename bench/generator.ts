import type { CanvasSection } from '@dowel/api';
import {
  chooseName,
  derivedUuid,
  emptyModel,
  joinNames,
  type Model,
  type Obj,
  runMutator,
} from '@dowel/core';

import { collectNeighborhood, suggestSectionsByPrefix } from '../apps/web/src/sections.ts';

export interface GenerateSchemaOptions {
  tableCount: number;
  seed?: number;
}

export interface SchemaStats {
  schemas: number;
  enums: number;
  sequences: number;
  topLevelTables: number;
  partitionParents: number;
  partitionChildren: number;
  columns: number;
  primaryKeys: number;
  uniques: number;
  foreignKeys: number;
  checks: number;
  indexes: number;
  totalObjects: number;
  jsonBytes: number;
}

export interface GeneratedSchema {
  tableCount: number;
  seed: number;
  model: Model;
  sections: CanvasSection[];
  stats: SchemaStats;
  focusTableId: string;
  focus1HopCount: number;
  focus2HopCount: number;
  mutateTargetTableId: string;
  mutateTargetTenantColId: string;
  mutateTargetColumnId: string;
}

export interface SmallChangeVariant {
  v2: Model;
  targetTableId: string;
  addedColumnId: string;
  addedIndexId: string;
  renamedColumnId: string;
}

interface DomainSpec {
  prefix: string;
  schema: string;
}

const DOMAINS: readonly DomainSpec[] = [
  { prefix: 'auth', schema: 'public' },
  { prefix: 'org', schema: 'public' },
  { prefix: 'catalog', schema: 'commerce' },
  { prefix: 'order', schema: 'commerce' },
  { prefix: 'inventory', schema: 'commerce' },
  { prefix: 'billing', schema: 'finance' },
  { prefix: 'ledger', schema: 'finance' },
  { prefix: 'notif', schema: 'ops' },
  { prefix: 'audit', schema: 'ops' },
  { prefix: 'analytics', schema: 'analytics' },
];

const SUB_ENTITIES = ['acct', 'item', 'entry', 'rule', 'log', 'job', 'node', 'tag', 'link', 'snap'] as const;

const SCHEMA_NAMES = ['public', 'commerce', 'finance', 'ops', 'analytics'] as const;

// 预生成的合法 fractional-indexing 递增键（支持最多 20 列/表）
const COL_POS = [
  'a0',
  'a1',
  'a2',
  'a3',
  'a4',
  'a5',
  'a6',
  'a7',
  'a8',
  'a9',
  'aA',
  'aB',
  'aC',
  'aD',
  'aE',
  'aF',
  'aG',
  'aH',
  'aI',
  'aJ',
] as const;

const DEFAULT_SEQ_OPTIONS = {
  type: 'bigint' as const,
  increment: '1',
  min: null,
  max: null,
  start: null,
  cache: '1',
  cycle: false,
};

const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

interface TableMeta {
  index: number;
  id: string;
  name: string;
  schemaId: string;
  domainIdx: number;
  isPartitionParent: boolean;
  idColId: string;
  tenantColId: string;
  payloadColId: string;
  inDegree: number;
}

/**
 * O(N) 确定性大规模 PostgreSQL IR 生成器（支持 100 / 1,000+ 表）。
 * 直接构建合法扁平 IR 并用本地索引表维护关系/约束命名去重，避免重复全表扫描。
 */
export const generateLargeSchema = (opts: GenerateSchemaOptions): GeneratedSchema => {
  const { tableCount, seed = 20261123 } = opts;
  if (!Number.isInteger(tableCount) || tableCount < 10) {
    throw new Error(`tableCount 必须是 >= 10 的整数，当前为 ${String(tableCount)}`);
  }

  const rand = mulberry32(seed ^ tableCount);
  const idFor = (key: string) => derivedUuid(`bench:${seed}:${tableCount}:${key}`);
  const model = emptyModel('pg');
  const put = (o: Obj) => {
    model.objects[o.id] = o;
  };

  // 每 schema 维护 relNames / typeNames，每表维护 conNames，确保 O(1) 命名无冲突
  const relNames = new Map<string, Set<string>>();
  const typeNames = new Map<string, Set<string>>();
  const conNames = new Map<string, Set<string>>();
  const claimRel = (schemaId: string, n1: string, n2: string | null, label: string): string => {
    let set = relNames.get(schemaId);
    if (!set) {
      set = new Set();
      relNames.set(schemaId, set);
    }
    const chosen = chooseName(n1, n2, label, (cand) => set.has(cand));
    set.add(chosen);
    return chosen;
  };
  const claimCon = (tableId: string, n1: string, n2: string | null, label: string): string => {
    let set = conNames.get(tableId);
    if (!set) {
      set = new Set();
      conNames.set(tableId, set);
    }
    const chosen = chooseName(n1, n2, label, (cand) => set.has(cand));
    set.add(chosen);
    return chosen;
  };
  const claimRelAndCon = (
    schemaId: string,
    tableId: string,
    n1: string,
    n2: string | null,
    label: string,
  ): string => {
    let rset = relNames.get(schemaId);
    if (!rset) {
      rset = new Set();
      relNames.set(schemaId, rset);
    }
    let cset = conNames.get(tableId);
    if (!cset) {
      cset = new Set();
      conNames.set(tableId, cset);
    }
    const chosen = chooseName(n1, n2, label, (cand) => rset.has(cand) || cset.has(cand));
    rset.add(chosen);
    cset.add(chosen);
    return chosen;
  };

  // 1. 5 个 Schema
  const schemaIds = new Map<string, string>();
  for (const name of SCHEMA_NAMES) {
    const id = idFor(`schema:${name}`);
    schemaIds.set(name, id);
    put({ id, kind: 'schema', name, comment: null });
    relNames.set(id, new Set());
    typeNames.set(id, new Set());
  }

  // 2. 每域 2 个枚举（共 20 个枚举）
  const domainStatusEnumId: string[] = [];
  for (let d = 0; d < DOMAINS.length; d++) {
    const dom = DOMAINS[d]!;
    const schemaId = schemaIds.get(dom.schema)!;
    const tset = typeNames.get(schemaId)!;

    const statusName = `${dom.prefix}_status`;
    const statusId = idFor(`enum:${statusName}`);
    tset.add(statusName);
    domainStatusEnumId.push(statusId);
    put({
      id: statusId,
      kind: 'enum',
      parent: schemaId,
      name: statusName,
      values: ['draft', 'active', 'archived'],
      comment: null,
    });

    const tierName = `${dom.prefix}_tier`;
    const tierId = idFor(`enum:${tierName}`);
    tset.add(tierName);
    put({
      id: tierId,
      kind: 'enum',
      parent: schemaId,
      name: tierName,
      values: ['standard', 'priority', 'critical'],
      comment: null,
    });
  }

  // 计算每域表数量分配（确保总数恰好为 tableCount）
  const domainCounts = DOMAINS.map((_, idx) => {
    const base = Math.floor(tableCount / DOMAINS.length);
    const rem = tableCount % DOMAINS.length;
    return base + (idx < rem ? 1 : 0);
  });

  // 分配分区父表数量（~2%：100 表为 2 张，1,000 表为 20 张）
  const targetPartitions = Math.max(2, Math.round(tableCount * 0.02));
  const domainPartCounts = DOMAINS.map(() => 0);
  for (let p = 0; p < targetPartitions; p++) {
    const dIdx = (3 + p * 3) % DOMAINS.length;
    if (domainPartCounts[dIdx]! < Math.floor(domainCounts[dIdx]! / 2)) {
      domainPartCounts[dIdx]! += 1;
    } else {
      domainPartCounts[p % DOMAINS.length]! += 1;
    }
  }

  let seqCount = 0;
  let partParentCount = 0;
  let partChildCount = 0;
  let colCount = 0;
  let pkCount = 0;
  let uniqCount = 0;
  let fkCount = 0;
  let checkCount = 0;
  let idxCount = 0;

  // 生成每张顶层表，先按全局索引依次生成表及基础列、PK/Unique/Check/Index，同时记录候选 FK 目标池
  const tables: TableMeta[] = [];
  const domainTables: TableMeta[][] = DOMAINS.map(() => []);
  const nonPartPool: TableMeta[] = [];

  let globalIdx = 0;
  // 按轮次交叉生成各域表（第 k 轮每域各 1 张），使严格 DAG 向前引用自然同时覆盖同域与跨域关联
  const maxPerDomain = Math.max(...domainCounts);
  for (let localIdx = 0; localIdx < maxPerDomain; localIdx++) {
    for (let domainIdx = 0; domainIdx < DOMAINS.length; domainIdx++) {
      const domTotal = domainCounts[domainIdx]!;
      if (localIdx >= domTotal) continue;

      const dom = DOMAINS[domainIdx]!;
      const schemaId = schemaIds.get(dom.schema)!;
      const isPartitionParent = localIdx >= domTotal - domainPartCounts[domainIdx]!;
      const sub = SUB_ENTITIES[(localIdx + domainIdx) % SUB_ENTITIES.length]!;
      const tableName = `${dom.prefix}_${sub}_${String(localIdx).padStart(3, '0')}`;
      const tableId = idFor(`table:${tableName}`);

      relNames.get(schemaId)!.add(tableName);
      typeNames.get(schemaId)!.add(tableName);
      conNames.set(tableId, new Set());

      let posIdx = 0;
      const addCol = (spec: {
        key: string;
        name: string;
        type: string;
        typeRef?: string | null;
        notNull?: boolean;
        default?: { expr: string } | { nextval: string } | null;
        useIdentity?: boolean;
      }): string => {
        const cid = idFor(`col:${tableName}:${spec.key}`);
        const identity = spec.useIdentity
          ? {
              always: false,
              sequenceName: claimRel(schemaId, tableName, spec.name, 'seq'),
              sequenceNameMode: 'derived' as const,
              options: { ...DEFAULT_SEQ_OPTIONS },
            }
          : null;
        put({
          id: cid,
          kind: 'column',
          parent: tableId,
          name: spec.name,
          pos: COL_POS[posIdx++]!,
          type: spec.type,
          typeRef: spec.typeRef ?? null,
          notNull: Boolean(spec.notNull || identity),
          notNullName: null,
          notNullNameMode: 'derived',
          default: identity ? null : (spec.default ?? null),
          identity,
          generated: null,
          collation: null,
          comment: null,
        });
        colCount++;
        return cid;
      };

      const useIdentity = !isPartitionParent && globalIdx % 2 === 0;
      const idColId = addCol({ key: 'id', name: 'id', type: 'bigint', notNull: true, useIdentity });
      const tenantColId = addCol({ key: 'tenant_id', name: 'tenant_id', type: 'bigint', notNull: true });
      const codeColId = addCol({
        key: 'code',
        name: 'code',
        type: 'character varying(64)',
        notNull: true,
      });
      addCol({ key: 'name', name: 'name', type: 'text', notNull: true });
      const statusColId = addCol({
        key: 'status',
        name: 'status_tags',
        type: '[]',
        typeRef: domainStatusEnumId[domainIdx]!,
        notNull: true,
      });
      addCol({
        key: 'amount',
        name: 'amount',
        type: 'numeric(12,2)',
        notNull: true,
        default: { expr: '0' },
      });
      addCol({ key: 'flags', name: 'flags', type: 'integer', notNull: true, default: { expr: '0' } });
      const payloadColId = addCol({ key: 'payload', name: 'payload', type: 'jsonb', notNull: false });
      const createdColId = addCol({
        key: 'created_at',
        name: 'created_at',
        type: 'timestamp with time zone',
        notNull: true,
        default: { expr: 'now()' },
      });
      const updatedColId = addCol({
        key: 'updated_at',
        name: 'updated_at',
        type: 'timestamp with time zone',
        notNull: true,
        default: { expr: 'now()' },
      });

      let partDateColId: string | null = null;
      if (isPartitionParent) {
        partDateColId = addCol({ key: 'part_date', name: 'part_date', type: 'date', notNull: true });
      }

      if (!isPartitionParent && localIdx % 10 === 0) {
        const seqId = idFor(`seq:${tableName}:seq_no`);
        const seqName = claimRel(schemaId, tableName, 'seq_no', 'seq');
        const seqColId = addCol({
          key: 'seq_no',
          name: 'seq_no',
          type: 'bigint',
          notNull: true,
          default: { nextval: seqId },
        });
        put({
          id: seqId,
          kind: 'sequence',
          parent: schemaId,
          name: seqName,
          nameMode: 'explicit',
          ownedBy: seqColId,
          options: { ...DEFAULT_SEQ_OPTIONS },
          comment: null,
        });
        seqCount++;
      }

      if (globalIdx % 2 === 1) {
        addCol({ key: 'notes', name: 'notes', type: 'text', notNull: false });
      }

      // 建表对象
      put({
        id: tableId,
        kind: 'table',
        parent: schemaId,
        name: tableName,
        partitionBy: isPartitionParent
          ? {
              strategy: 'range',
              keys: [{ column: partDateColId!, expr: null, opclass: null, collation: null }],
            }
          : null,
        partitionOf: null,
        comment: null,
      });

      // 主键（分区父表必须包含分区键）
      const pkCols = isPartitionParent ? [idColId, partDateColId!] : [idColId];
      put({
        id: idFor(`pk:${tableName}`),
        kind: 'primaryKey',
        parent: tableId,
        name: claimRelAndCon(schemaId, tableId, tableName, null, 'pkey'),
        nameMode: 'derived',
        columns: pkCols,
        comment: null,
      });
      pkCount++;

      // 分区子表（3 个/父表）
      if (isPartitionParent) {
        partParentCount++;
        const bounds: readonly [string, string][] = [
          ['p2025', "FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')"],
          ['p2026', "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')"],
          ['pdef', 'DEFAULT'],
        ];
        for (const [suffix, bound] of bounds) {
          const partName = `${tableName}_${suffix}`;
          relNames.get(schemaId)!.add(partName);
          typeNames.get(schemaId)!.add(partName);
          put({
            id: idFor(`part:${partName}`),
            kind: 'table',
            parent: schemaId,
            name: partName,
            partitionBy: null,
            partitionOf: { parent: tableId, bound },
            comment: null,
          });
          partChildCount++;
        }
      }

      // 唯一约束（非分区表 ~60%）
      if (!isPartitionParent && globalIdx % 5 < 3) {
        put({
          id: idFor(`uq:${tableName}:tenant_code`),
          kind: 'unique',
          parent: tableId,
          name: claimRelAndCon(schemaId, tableId, tableName, joinNames(['tenant_id', 'code']), 'key'),
          nameMode: 'derived',
          columns: [tenantColId, codeColId],
          nullsNotDistinct: false,
          comment: null,
        });
        uniqCount++;
      }

      // CHECK 约束（~70%，兼容分区表）
      if (globalIdx % 10 < 7) {
        put({
          id: idFor(`chk:${tableName}:amount`),
          kind: 'check',
          parent: tableId,
          name: claimCon(tableId, tableName, 'amount', 'check'),
          nameMode: 'derived',
          expr: 'amount >= 0',
          noInherit: false,
          comment: null,
        });
        checkCount++;
      }

      // 两个索引：1) 复合租户时间倒序索引；2) 状态更新索引（部分表带 partial where）
      put({
        id: idFor(`idx:${tableName}:tenant_created`),
        kind: 'index',
        parent: tableId,
        name: claimRel(schemaId, tableName, joinNames(['tenant_id', 'created_at']), 'idx'),
        nameMode: 'derived',
        unique: false,
        method: 'btree',
        elements: [
          {
            column: tenantColId,
            expr: null,
            desc: false,
            nullsFirst: null,
            opclass: null,
            collation: null,
          },
          {
            column: createdColId,
            expr: null,
            desc: true,
            nullsFirst: null,
            opclass: null,
            collation: null,
          },
        ],
        include: [],
        where: null,
        nullsNotDistinct: false,
        comment: null,
      });
      idxCount++;

      put({
        id: idFor(`idx:${tableName}:status_updated`),
        kind: 'index',
        parent: tableId,
        name: claimRel(schemaId, tableName, joinNames(['status_tags', 'updated_at']), 'idx'),
        nameMode: 'derived',
        unique: false,
        method: 'btree',
        elements: [
          {
            column: statusColId,
            expr: null,
            desc: false,
            nullsFirst: null,
            opclass: null,
            collation: null,
          },
          {
            column: updatedColId,
            expr: null,
            desc: false,
            nullsFirst: null,
            opclass: null,
            collation: null,
          },
        ],
        include: [],
        where: globalIdx % 5 < 2 ? 'flags > 0' : null,
        nullsNotDistinct: false,
        comment: null,
      });
      idxCount++;

      // 创建外键（严格向前 DAG，仅引用非分区父表，平均 1.5 条/表，限制目标入度防星型爆炸）
      let wantedFks = 0;
      if (nonPartPool.length > 0) {
        if (globalIdx >= 1 && globalIdx <= 5) wantedFks = 1;
        else if (globalIdx >= 6) {
          wantedFks = 1 + (globalIdx % 2 === 0 ? 1 : 0);
          if (globalIdx >= 20 && globalIdx <= 80 && globalIdx % 20 === 0) wantedFks += 1;
        }
      }

      const usedTargets = new Set<string>();
      const sameDomTargets = domainTables[domainIdx]!.filter((t) => !t.isPartitionParent && t.inDegree < 8);
      const crossDomTargets = nonPartPool.filter((t) => t.domainIdx !== domainIdx && t.inDegree < 8);

      for (let f = 0; f < wantedFks; f++) {
        const preferSame = rand() < 0.75;
        const primaryPool = preferSame ? sameDomTargets : crossDomTargets;
        const fallbackPool = preferSame ? crossDomTargets : sameDomTargets;
        const pickFrom = (pool: TableMeta[]): TableMeta | null => {
          const candidates = pool.filter((t) => !usedTargets.has(t.id) && t.inDegree < 8);
          if (candidates.length === 0) return null;
          return candidates[Math.floor(rand() * candidates.length)]!;
        };
        const target = pickFrom(primaryPool) ?? pickFrom(fallbackPool);
        if (!target) break;

        usedTargets.add(target.id);
        target.inDegree++;

        const fkColName = `ref_${f + 1}_id`;
        const fkColId = idFor(`col:${tableName}:${fkColName}`);
        put({
          id: fkColId,
          kind: 'column',
          parent: tableId,
          name: fkColName,
          pos: COL_POS[posIdx++]!,
          type: 'bigint',
          typeRef: null,
          notNull: false,
          notNullName: null,
          notNullNameMode: 'derived',
          default: null,
          identity: null,
          generated: null,
          collation: null,
          comment: null,
        });
        colCount++;

        put({
          id: idFor(`fk:${tableName}:${fkColName}`),
          kind: 'foreignKey',
          parent: tableId,
          name: claimCon(tableId, tableName, fkColName, 'fkey'),
          nameMode: 'derived',
          columns: [fkColId],
          refTable: target.id,
          refColumns: [target.idColId],
          onDelete: 'noAction',
          onUpdate: 'noAction',
          match: 'simple',
          deferrable: false,
          initiallyDeferred: false,
          comment: null,
        });
        fkCount++;
      }

      const meta: TableMeta = {
        index: globalIdx,
        id: tableId,
        name: tableName,
        schemaId,
        domainIdx,
        isPartitionParent,
        idColId,
        tenantColId,
        payloadColId,
        inDegree: 0,
      };
      tables.push(meta);
      domainTables[domainIdx]!.push(meta);
      if (!isPartitionParent) nonPartPool.push(meta);

      globalIdx++;
    }
  }

  // 3. 用 Phase 1 前缀建议生成标准画布板块（10 个板块）
  const sections = suggestSectionsByPrefix(model, []);

  // 4. 在 order 域（index 3）采样代表非分区表，选出最适合 1 跳 / 2 跳邻域聚焦与小改动变异的表
  const orderTables = domainTables[3]!.filter((t) => !t.isPartitionParent);
  const sampleStep = Math.max(1, Math.floor(orderTables.length / 12));
  const focusCandidates = orderTables.filter((_, idx) => idx % sampleStep === 0).slice(0, 12);
  let bestFocus = focusCandidates[Math.floor(focusCandidates.length / 2)] ?? nonPartPool[0]!;
  let best1Hop = 0;
  let best2Hop = 0;
  let bestScore = -1;
  for (const cand of focusCandidates) {
    const h1 = collectNeighborhood(model, cand.id, 1).size;
    const h2 = collectNeighborhood(model, cand.id, 2).size;
    let score = 0;
    if (h1 >= 4 && h1 <= 15) score += 100;
    else if (h1 >= 2) score += 20;
    if (h2 >= 8 && h2 <= 60) score += 100;
    else if (h2 >= h1) score += 20;
    score -= Math.abs(h1 - 6) + Math.abs(h2 - 20) * 0.25;
    if (score > bestScore) {
      bestScore = score;
      bestFocus = cand;
      best1Hop = h1;
      best2Hop = h2;
    }
  }
  if (best1Hop === 0) {
    best1Hop = collectNeighborhood(model, bestFocus.id, 1).size;
    best2Hop = collectNeighborhood(model, bestFocus.id, 2).size;
  }

  const mutateTarget = orderTables[0] ?? nonPartPool[0]!;
  const stats: SchemaStats = {
    schemas: SCHEMA_NAMES.length,
    enums: DOMAINS.length * 2,
    sequences: seqCount,
    topLevelTables: tables.length,
    partitionParents: partParentCount,
    partitionChildren: partChildCount,
    columns: colCount,
    primaryKeys: pkCount,
    uniques: uniqCount,
    foreignKeys: fkCount,
    checks: checkCount,
    indexes: idxCount,
    totalObjects: Object.keys(model.objects).length,
    jsonBytes: Buffer.byteLength(JSON.stringify(model), 'utf8'),
  };

  return {
    tableCount,
    seed,
    model,
    sections,
    stats,
    focusTableId: bestFocus.id,
    focus1HopCount: best1Hop,
    focus2HopCount: best2Hop,
    mutateTargetTableId: mutateTarget.id,
    mutateTargetTenantColId: mutateTarget.tenantColId,
    mutateTargetColumnId: mutateTarget.payloadColId,
  };
};

/** 对基线模型施加典型小改动（加列 + 加复合索引 + 改列名），用于 plan() 与影子库闭环验证基准 */
export const createSmallChangeVariant = (gen: GeneratedSchema): SmallChangeVariant => {
  const v2 = structuredClone(gen.model);
  const addedColumnId = derivedUuid(`bench:v2:addcol:${gen.tableCount}:${gen.seed}`);
  const addedIndexId = derivedUuid(`bench:v2:addidx:${gen.tableCount}:${gen.seed}`);

  runMutator(v2, 'addColumn', {
    table: gen.mutateTargetTableId,
    column: {
      id: addedColumnId,
      name: 'bench_memo',
      type: 'text',
      notNull: false,
    },
  });
  runMutator(v2, 'addIndex', {
    id: addedIndexId,
    table: gen.mutateTargetTableId,
    elements: [{ column: gen.mutateTargetTenantColId }, { column: addedColumnId }],
  });
  runMutator(v2, 'renameColumn', {
    id: gen.mutateTargetColumnId,
    name: 'meta_payload',
  });

  return {
    v2,
    targetTableId: gen.mutateTargetTableId,
    addedColumnId,
    addedIndexId,
    renamedColumnId: gen.mutateTargetColumnId,
  };
};
