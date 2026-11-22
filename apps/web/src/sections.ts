// 纯布局层画布板块（Section）、前缀建议、N 跳邻域聚焦、汇总分组与本地视图偏好。
// 绝不读写或修改 @dowel/core IR，不影响 DDL、diff、迁移规划或版本快照。
import { type CanvasSection, SECTION_COLORS, type SectionColor, sanitizeSections } from '@dowel/api';
import { all, type Model, type ModelIndex, type Table } from '@dowel/core';

export const LARGE_SCHEMA_THRESHOLD = 100;
export const UNASSIGNED_GROUP_ID = '__unassigned__';
export const SUMMARY_NODE_PREFIX = 'section-summary:';

export type SidebarGrouping = 'schema' | 'section';
export type CanvasViewMode = 'auto' | 'sections' | 'flat';

export interface FocusState {
  tableId: string;
  hops: 1 | 2;
}

export interface CanvasViewPrefs {
  sidebarGrouping: SidebarGrouping;
  viewMode: CanvasViewMode;
  expandedGroups: string[];
  focus: FocusState | null;
}

export interface CanvasGroup {
  id: string;
  kind: 'section' | 'unassigned' | 'schema';
  name: string;
  color: SectionColor | null;
  tableIds: string[];
  crossGroupFkCount: number;
}

export interface SummaryEdge {
  id: string;
  sourceGroupId: string;
  targetGroupId: string;
  count: number;
}

const NOISE_PREFIXES = new Set(['t', 'tbl', 'tb']);
const KEEP_TRAILING_S = new Set(['sys', 'status', 'access', 'address']);

/** 沿 partitionOf 链路解析顶层表 ID（带环路保护），非表或不存在返回 null */
export const resolveTopLevelTableId = (model: Model, tableId: string): string | null => {
  const seen = new Set<string>();
  let cur = model.objects[tableId];
  while (cur && cur.kind === 'table' && cur.partitionOf) {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    cur = model.objects[cur.partitionOf.parent];
  }
  return cur && cur.kind === 'table' ? cur.id : null;
};

const extractPrefixToken = (tableName: string): string | null => {
  const parts = tableName
    .trim()
    .toLowerCase()
    .split(/[_-]+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  let token = parts[0]!;
  if (NOISE_PREFIXES.has(token) && parts.length > 1) {
    token = parts[1]!;
  }
  if (token.length < 2 || /^\d+$/.test(token)) return null;
  return token;
};

const normalizePrefixToken = (token: string): string => {
  if (KEEP_TRAILING_S.has(token)) return token;
  if (token.length > 4 && token.endsWith('ies')) {
    return `${token.slice(0, -3)}y`;
  }
  if (
    token.length > 4 &&
    (token.endsWith('ses') ||
      token.endsWith('xes') ||
      token.endsWith('zes') ||
      token.endsWith('ches') ||
      token.endsWith('shes'))
  ) {
    return token.slice(0, -2);
  }
  if (
    token.length > 3 &&
    token.endsWith('s') &&
    !token.endsWith('ss') &&
    !token.endsWith('us') &&
    !token.endsWith('is')
  ) {
    return token.slice(0, -1);
  }
  return token;
};

/**
 * 根据表名前缀为尚未归属任何板块的顶层表生成建议板块：
 * - 仅处理 !t.partitionOf 且未出现在 existingSections 中的表；
 * - 按 _ / - 提取首段（跳过 t/tbl/tb 噪声前缀），做轻量单复数归一；
 * - 仅形成成员数 >= 2 的板块，按名称确定性排序并轮询分配配色，不修改入参。
 */
export const suggestSectionsByPrefix = (
  model: Model,
  existingSections: readonly CanvasSection[],
  index?: ModelIndex,
): CanvasSection[] => {
  const assigned = new Set<string>();
  const usedIds = new Set<string>();
  for (const sec of existingSections) {
    usedIds.add(sec.id);
    for (const tid of sec.tables) assigned.add(tid);
  }

  const buckets = new Map<string, { rawTokens: Set<string>; tables: Table[] }>();
  for (const t of index ? index.allRef('table') : all(model, 'table')) {
    if (t.partitionOf || assigned.has(t.id)) continue;
    const raw = extractPrefixToken(t.name);
    if (!raw) continue;
    const norm = normalizePrefixToken(raw);
    let bucket = buckets.get(norm);
    if (!bucket) {
      bucket = { rawTokens: new Set(), tables: [] };
      buckets.set(norm, bucket);
    }
    bucket.rawTokens.add(raw);
    bucket.tables.push(t);
  }

  const candidates: { name: string; key: string; tableIds: string[] }[] = [];
  for (const [norm, bucket] of buckets) {
    if (bucket.tables.length < 2) continue;
    const name = bucket.rawTokens.size === 1 ? [...bucket.rawTokens][0]! : norm;
    const sorted = [...bucket.tables].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    candidates.push({
      name,
      key: norm,
      tableIds: sorted.map((t) => t.id),
    });
  }

  candidates.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));

  return candidates.map((cand, idx) => {
    const baseId = `sec-${cand.key}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix++}`;
    }
    usedIds.add(id);
    const color = SECTION_COLORS[(existingSections.length + idx) % SECTION_COLORS.length]!;
    return {
      id,
      name: cand.name,
      color,
      tables: cand.tableIds,
    };
  });
};

const fkAdjCache = new WeakMap<ModelIndex, Map<string, Set<string>>>();

const getFkAdjacency = (model: Model, index?: ModelIndex): Map<string, Set<string>> => {
  if (index) {
    const cached = fkAdjCache.get(index);
    if (cached) return cached;
  }
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    let setA = adj.get(a);
    if (!setA) {
      setA = new Set();
      adj.set(a, setA);
    }
    setA.add(b);
  };

  for (const fk of index ? index.allRef('foreignKey') : all(model, 'foreignKey')) {
    const src = resolveTopLevelTableId(model, fk.parent);
    const dst = resolveTopLevelTableId(model, fk.refTable);
    if (!src || !dst || src === dst) continue;
    link(src, dst);
    link(dst, src);
  }
  if (index) fkAdjCache.set(index, adj);
  return adj;
};

/**
 * 沿外键边做无向 BFS，收集以 rootTableId 为中心、深度 <= hops（1 或 2）的顶层表集合。
 * 总是包含 rootTableId（若其存在于模型中）；自动解析分区子表外键到其顶层父表。
 */
export const collectNeighborhood = (
  model: Model,
  rootTableId: string,
  hops: 1 | 2,
  index?: ModelIndex,
): Set<string> => {
  const root = resolveTopLevelTableId(model, rootTableId);
  if (!root) return new Set();

  const adj = getFkAdjacency(model, index);

  const visited = new Set<string>([root]);
  const queue: { id: string; depth: number }[] = [{ id: root, depth: 0 }];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    if (cur.depth >= hops) continue;
    const neighbors = adj.get(cur.id);
    if (!neighbors) continue;
    for (const next of neighbors) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push({ id: next, depth: cur.depth + 1 });
    }
  }
  return visited;
};

export const effectiveCanvasMode = (
  viewMode: CanvasViewMode,
  topLevelTableCount: number,
): 'flat' | 'sections' => {
  if (viewMode === 'auto') {
    return topLevelTableCount > LARGE_SCHEMA_THRESHOLD ? 'sections' : 'flat';
  }
  return viewMode;
};

/**
 * 计算汇总视图下的画布分组、每表归属与跨组外键汇总边：
 * - 当 sections.length > 0 时按板块分组，并将未归属表纳入 UNASSIGNED_GROUP_ID；
 * - 当 sections.length === 0 时按 Schema 兜底分组。
 */
export const buildCanvasGroups = (
  model: Model,
  sections: readonly CanvasSection[],
  index?: ModelIndex,
): {
  groups: CanvasGroup[];
  summaryEdges: SummaryEdge[];
  tableToGroup: Map<string, string>;
} => {
  const topTables = (index ? index.allRef('table') : all(model, 'table'))
    .filter((t) => !t.partitionOf)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const topTableIds = new Set(topTables.map((t) => t.id));
  const tableToGroup = new Map<string, string>();
  const groups: CanvasGroup[] = [];

  if (sections.length > 0) {
    const clean = sanitizeSections(sections);
    for (const sec of clean) {
      const members = sec.tables.filter((tid) => topTableIds.has(tid) && !tableToGroup.has(tid));
      for (const tid of members) tableToGroup.set(tid, sec.id);
      groups.push({
        id: sec.id,
        kind: 'section',
        name: sec.name,
        color: sec.color,
        tableIds: members,
        crossGroupFkCount: 0,
      });
    }
    const unassigned = topTables.filter((t) => !tableToGroup.has(t.id)).map((t) => t.id);
    if (unassigned.length > 0) {
      for (const tid of unassigned) tableToGroup.set(tid, UNASSIGNED_GROUP_ID);
      groups.push({
        id: UNASSIGNED_GROUP_ID,
        kind: 'unassigned',
        name: '',
        color: null,
        tableIds: unassigned,
        crossGroupFkCount: 0,
      });
    }
  } else {
    const bySchema = new Map<string, { schemaId: string; schemaName: string; tableIds: string[] }>();
    for (const t of topTables) {
      const schemaName = model.objects[t.parent]?.name ?? 'public';
      let bucket = bySchema.get(t.parent);
      if (!bucket) {
        bucket = { schemaId: t.parent, schemaName, tableIds: [] };
        bySchema.set(t.parent, bucket);
      }
      bucket.tableIds.push(t.id);
    }
    const sortedSchemas = [...bySchema.values()].sort(
      (a, b) => a.schemaName.localeCompare(b.schemaName) || a.schemaId.localeCompare(b.schemaId),
    );
    sortedSchemas.forEach((s, idx) => {
      const gid = `schema:${s.schemaId}`;
      for (const tid of s.tableIds) tableToGroup.set(tid, gid);
      groups.push({
        id: gid,
        kind: 'schema',
        name: s.schemaName,
        color: SECTION_COLORS[idx % SECTION_COLORS.length]!,
        tableIds: s.tableIds,
        crossGroupFkCount: 0,
      });
    });
  }

  const groupMap = new Map(groups.map((g) => [g.id, g]));
  const edgeMap = new Map<string, SummaryEdge>();
  for (const fk of index ? index.allRef('foreignKey') : all(model, 'foreignKey')) {
    const srcTable = resolveTopLevelTableId(model, fk.parent);
    const dstTable = resolveTopLevelTableId(model, fk.refTable);
    if (!srcTable || !dstTable) continue;
    const sg = tableToGroup.get(srcTable);
    const dg = tableToGroup.get(dstTable);
    if (!sg || !dg || sg === dg) continue;

    const srcGroup = groupMap.get(sg);
    const dstGroup = groupMap.get(dg);
    if (srcGroup) srcGroup.crossGroupFkCount += 1;
    if (dstGroup) dstGroup.crossGroupFkCount += 1;

    const key = `${sg}->${dg}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      edgeMap.set(key, { id: `sum-edge:${key}`, sourceGroupId: sg, targetGroupId: dg, count: 1 });
    }
  }

  return {
    groups,
    summaryEdges: [...edgeMap.values()],
    tableToGroup,
  };
};

// ───── 本地视图偏好（仅存浏览器 localStorage，绝不经 WS 同步） ─────

export const canvasViewStorageKey = (pid: string) => `dowel.canvasView.${pid}`;

export const defaultCanvasViewPrefs = (): CanvasViewPrefs => ({
  sidebarGrouping: 'schema',
  viewMode: 'auto',
  expandedGroups: [],
  focus: null,
});

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const defaultStorage = (): StorageLike | null =>
  (globalThis as { localStorage?: StorageLike }).localStorage ?? null;

export const readCanvasViewPrefs = (
  pid: string,
  storage: Pick<StorageLike, 'getItem'> | null | undefined = defaultStorage(),
): CanvasViewPrefs => {
  const fallback = defaultCanvasViewPrefs();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(canvasViewStorageKey(pid));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return fallback;
    const rec = parsed as Record<string, unknown>;

    const sidebarGrouping: SidebarGrouping =
      rec.sidebarGrouping === 'section' || rec.sidebarGrouping === 'schema' ? rec.sidebarGrouping : 'schema';
    const viewMode: CanvasViewMode =
      rec.viewMode === 'auto' || rec.viewMode === 'sections' || rec.viewMode === 'flat'
        ? rec.viewMode
        : 'auto';
    const expandedGroups = Array.isArray(rec.expandedGroups)
      ? [...new Set(rec.expandedGroups.filter((x): x is string => typeof x === 'string' && x.length > 0))]
      : [];

    let focus: FocusState | null = null;
    if (rec.focus && typeof rec.focus === 'object') {
      const f = rec.focus as Record<string, unknown>;
      if (typeof f.tableId === 'string' && f.tableId.length > 0 && (f.hops === 1 || f.hops === 2)) {
        focus = { tableId: f.tableId, hops: f.hops };
      }
    }

    return { sidebarGrouping, viewMode, expandedGroups, focus };
  } catch {
    return fallback;
  }
};

export const writeCanvasViewPrefs = (
  pid: string,
  prefs: CanvasViewPrefs,
  storage: Pick<StorageLike, 'setItem'> | null | undefined = defaultStorage(),
): void => {
  if (!storage) return;
  try {
    storage.setItem(canvasViewStorageKey(pid), JSON.stringify(prefs));
  } catch {
    // 忽略无痕模式/配额限制导致的写入异常
  }
};
