// 画布：支持 <=100 表平铺、>100 表默认板块折叠汇总卡片、按需 elkjs 布局与单表 N 跳外键邻域聚焦（DESIGN.md：画布）。
import { type CanvasSection, sectionColorCssVar } from '@dowel/api';
import { all, columnsOf, type Model, partitionKeyColumns, resolvePartitionBy, type Table } from '@dowel/core';
import {
  Background,
  BackgroundVariant,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  useReactFlow,
  useViewport,
} from '@xyflow/react';

import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import { Focus, Maximize, Table2, ZoomIn, ZoomOut } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { defaultSchemaOf } from '../dialects.ts';
import {
  buildCanvasGroups,
  type CanvasGroup,
  type CanvasViewMode,
  collectNeighborhood,
  effectiveCanvasMode,
  type FocusState,
  LARGE_SCHEMA_THRESHOLD,
  resolveTopLevelTableId,
  SUMMARY_NODE_PREFIX,
} from '../sections.ts';
import type { Layout } from '../workspace.ts';
import { IconButton } from './ui.tsx';

type Col = {
  id: string;
  name: string;
  type: string;
  isEnum: boolean;
  key: 'PK' | 'FK' | 'UQ' | '';
  notNull: boolean;
  isPartKey: boolean;
};
type TableData = {
  table: Table;
  schema: string;
  defaultSchema: string;
  columns: Col[];
  partitions: number;
  partitionStrategy: string | null;
  selected: boolean;
};
type TableNode = Node<TableData, 'table'>;

type SummaryData = {
  group: CanvasGroup;
  hasSections: boolean;
  onExpand: (groupId: string) => void;
};
type SummaryNode = Node<SummaryData, 'sectionSummary'>;
type CanvasNode = TableNode | SummaryNode;

const NODE_W = 250;
const SUMMARY_W = 264;
const SUMMARY_H = 112;
const HEAD_H = 34;
const ROW_H = 26;
const nodeHeight = (cols: number) => HEAD_H + ROW_H * Math.max(cols, 1) + 2;

/** 每列左右各有一个起点和终点（不可见），连线连到具体的列 */
const RowHandles = ({ id }: { id: string }) => (
  <>
    <Handle type="source" id={`${id}-sl`} position={Position.Left} isConnectable={false} />
    <Handle type="source" id={`${id}-sr`} position={Position.Right} isConnectable={false} />
    <Handle type="target" id={`${id}-tl`} position={Position.Left} isConnectable={false} />
    <Handle type="target" id={`${id}-tr`} position={Position.Right} isConnectable={false} />
  </>
);

const KEY_CLASS = { PK: 'text-pk', FK: 'text-fk', UQ: 'text-text-3', '': '' };

const TableNodeView = memo(({ data }: NodeProps<TableNode>) => {
  const { t } = useTranslation();
  const partBadge = data.partitionStrategy
    ? `${data.partitionStrategy} · ${data.partitions}`
    : data.partitions > 0
      ? t('canvas.partitions', { count: data.partitions })
      : null;
  return (
    <div
      style={{ width: NODE_W }}
      className={`rounded-md border bg-[var(--node-bg)] font-mono shadow-[var(--shadow-node)] ${
        data.selected
          ? 'border-primary shadow-[0_0_0_3px_var(--primary-ring),var(--shadow-node)]'
          : 'border-[var(--node-border)]'
      }`}
    >
      <div
        style={{ height: HEAD_H }}
        className="flex items-center gap-[7px] rounded-t-md border-b border-[var(--node-border)] bg-[var(--node-head)] px-2.5 text-base font-semibold"
      >
        <Table2 size={14} aria-hidden="true" className="text-text-3" />
        <span className="min-w-0 flex-1 truncate">
          {data.schema !== data.defaultSchema && (
            <span className="font-normal text-text-3">{data.schema}.</span>
          )}
          {data.table.name}
        </span>
        {partBadge && (
          <span
            className="badge shrink-0 font-mono"
            title={t('canvas.partitions', { count: data.partitions })}
          >
            {partBadge}
          </span>
        )}
      </div>
      {data.columns.map((c) => (
        <div
          key={c.id}
          style={{ height: ROW_H }}
          className="relative flex items-center gap-1.5 px-2.5 text-sm"
        >
          <RowHandles id={c.id} />
          <span className={`w-5 text-[10px] font-semibold ${KEY_CLASS[c.key]}`}>{c.key}</span>
          <span className="min-w-0 flex-1 truncate">
            {c.name}
            {!c.notNull && <span className="text-text-3">?</span>}
          </span>
          {c.isPartKey && <b className="flag shrink-0">PT</b>}
          <span className={`truncate text-xs ${c.isEnum ? 'text-enum' : 'text-text-3'}`}>{c.type}</span>
        </div>
      ))}
      {data.columns.length === 0 && <div style={{ height: ROW_H }} />}
    </div>
  );
});

const SummaryNodeView = memo(({ data }: NodeProps<SummaryNode>) => {
  const { t } = useTranslation();
  const { group, hasSections, onExpand } = data;
  const displayName = group.kind === 'unassigned' ? t('sec.unassigned') : group.name;
  const dotColor = group.color ? sectionColorCssVar(group.color) : 'var(--border-strong)';
  const fkLabel = t(hasSections ? 'sec.crossSectionFk' : 'sec.crossSchemaFk', {
    count: group.crossGroupFkCount,
  });

  return (
    <div
      style={{ width: SUMMARY_W, minHeight: SUMMARY_H }}
      className="relative rounded-md border border-[var(--node-border)] bg-[var(--node-bg)] shadow-[var(--shadow-node)]"
    >
      <Handle type="source" id="sl" position={Position.Left} isConnectable={false} />
      <Handle type="source" id="sr" position={Position.Right} isConnectable={false} />
      <Handle type="target" id="tl" position={Position.Left} isConnectable={false} />
      <Handle type="target" id="tr" position={Position.Right} isConnectable={false} />
      <div
        style={{ height: HEAD_H }}
        className="flex items-center gap-2 rounded-t-md border-b border-[var(--node-border)] bg-[var(--node-head)] px-2.5 text-base font-semibold"
      >
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full"
          style={{ background: dotColor }}
        />
        <span className={`min-w-0 flex-1 truncate ${group.kind === 'schema' ? 'font-mono' : ''}`}>
          {displayName}
        </span>
        <span className="badge shrink-0 font-mono">{group.tableIds.length}</span>
      </div>
      <div className="flex flex-col gap-2.5 px-2.5 py-2.5">
        <div className="flex items-center justify-between gap-2 text-xs text-text-2">
          <span className="font-mono">{t('sec.tableCount', { count: group.tableIds.length })}</span>
          <span className="truncate font-mono text-text-3">{fkLabel}</span>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            className="btn sm nodrag nopan"
            aria-label={t('sec.expandGroupLabel', { name: displayName })}
            onClick={(e) => {
              e.stopPropagation();
              onExpand(group.id);
            }}
          >
            {t('sec.expand')}
          </button>
        </div>
      </div>
    </div>
  );
});

const nodeTypes = { table: TableNodeView, sectionSummary: SummaryNodeView };

export const typeLabel = (m: Model, c: { type: string; typeRef: string | null }) =>
  c.typeRef ? `${m.objects[c.typeRef]?.name ?? '?'}${c.type}` : c.type;

/** 列表里显示的短类型名（PG 的标准别名），编辑框里仍是完整写法 */
export const shortType = (t: string) =>
  t
    .replace(/^timestamp(\(\d+\))? with time zone/, 'timestamptz$1')
    .replace(/^timestamp(\(\d+\))? without time zone/, 'timestamp$1')
    .replace(/^time(\(\d+\))? with time zone/, 'timetz$1')
    .replace(/^time(\(\d+\))? without time zone/, 'time$1')
    .replace(/^character varying/, 'varchar')
    .replace(/^character\b/, 'char')
    .replace(/^double precision/, 'float8')
    .replace(/^bit varying/, 'varbit');

/** 用 elkjs 仅计算当前需要渲染且缺少位置的表的位置（绝不对已折叠的百/千表运行布局） */
const autoLayout = async (m: Model, tables: Table[], fixed: Layout): Promise<Layout> => {
  const elk = new ELK();
  const ids = new Set(tables.map((t) => t.id));
  const res = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
    },
    children: tables.map((t) => ({ id: t.id, width: NODE_W, height: nodeHeight(columnsOf(m, t.id).length) })),
    edges: all(m, 'foreignKey')
      .filter((f) => ids.has(f.parent) && ids.has(f.refTable) && f.parent !== f.refTable)
      .map((f) => ({ id: f.id, sources: [f.parent], targets: [f.refTable] })),
  });
  const out: Layout = {};
  // 已有位置的表不动；新算出的整体平移到已有内容的右侧
  const maxX = Math.max(0, ...Object.values(fixed).map((p) => p.x + NODE_W + 80));
  for (const c of res.children ?? []) if (!fixed[c.id]) out[c.id] = { x: (c.x ?? 0) + maxX, y: c.y ?? 0 };
  return out;
};

/** 外键连线的端点：鸦爪（多）在外键一端，短竖线（一）在被引用一端 */
const Markers = () => (
  <svg aria-hidden="true" className="absolute size-0">
    <defs>
      <marker
        id="dowel-many"
        viewBox="0 0 12 12"
        refX="1"
        refY="6"
        markerWidth="12"
        markerHeight="12"
        markerUnits="userSpaceOnUse"
        orient="auto-start-reverse"
      >
        <path d="M11 6 L1 1 M11 6 L1 6 M11 6 L1 11" fill="none" stroke="var(--edge)" strokeWidth="1.5" />
      </marker>
      <marker
        id="dowel-one"
        viewBox="0 0 12 12"
        refX="11"
        refY="6"
        markerWidth="12"
        markerHeight="12"
        markerUnits="userSpaceOnUse"
        orient="auto"
      >
        <path d="M8 1 L8 11" fill="none" stroke="var(--edge)" strokeWidth="1.5" />
      </marker>
    </defs>
  </svg>
);

/** 左下角缩放控件：放大、缩小、适应画布、当前比例 */
const ZoomPanel = () => {
  const { t } = useTranslation();
  const flow = useReactFlow();
  const { zoom } = useViewport();
  return (
    <Panel
      position="bottom-left"
      className="flex items-center gap-0.5 rounded-sm border border-border bg-surface p-0.5 shadow-[var(--shadow-sm)]"
    >
      <IconButton label={t('canvas.zoomIn')} className="!size-[26px]" onClick={() => void flow.zoomIn()}>
        <ZoomIn size={16} aria-hidden="true" />
      </IconButton>
      <IconButton label={t('canvas.zoomOut')} className="!size-[26px]" onClick={() => void flow.zoomOut()}>
        <ZoomOut size={16} aria-hidden="true" />
      </IconButton>
      <IconButton
        label={t('canvas.fit')}
        className="!size-[26px]"
        onClick={() => void flow.fitView({ padding: 0.1, duration: 250 })}
      >
        <Maximize size={16} aria-hidden="true" />
      </IconButton>
      <span className="w-11 px-1.5 text-center font-mono text-[11px] text-text-3">
        {Math.round(zoom * 100)}%
      </span>
    </Panel>
  );
};

const EMPTY_SECTIONS: CanvasSection[] = [];
const EMPTY_EXPANDED: string[] = [];

export const Canvas = ({
  model,
  layout,
  selected,
  onSelect,
  onMove,
  relayout,
  sections = EMPTY_SECTIONS,
  viewMode = 'auto',
  expandedGroups,
  onToggleGroup,
  onCollapseAllGroups,
  focus = null,
  onChangeFocus,
  onChangeViewMode,
  readOnly = false,
}: {
  model: Model;
  layout: Layout;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onMove: (l: Layout) => void;
  /** 变化时对当前可见表重新自动布局 */
  relayout: number;
  sections?: CanvasSection[];
  viewMode?: CanvasViewMode;
  expandedGroups?: string[];
  onToggleGroup?: (groupId: string) => void;
  onCollapseAllGroups?: () => void;
  focus?: FocusState | null;
  onChangeFocus?: (next: FocusState | null) => void;
  onChangeViewMode?: (mode: CanvasViewMode) => void;
  readOnly?: boolean;
}) => {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState<Layout>({});
  const [summaryPositions, setSummaryPositions] = useState<Layout>({});
  const [localFallback, setLocalFallback] = useState<Layout>({});
  const [localExpanded, setLocalExpanded] = useState<string[]>(EMPTY_EXPANDED);
  const [flow, setFlow] = useState<ReactFlowInstance<CanvasNode> | null>(null);
  const fitted = useRef(false);

  const tables = useMemo(() => all(model, 'table').filter((tb) => !tb.partitionOf), [model]);
  const activeExpanded = expandedGroups ?? localExpanded;
  const toggleGroup = useCallback(
    (groupId: string) => {
      if (onToggleGroup) {
        onToggleGroup(groupId);
        return;
      }
      setLocalExpanded((prev) =>
        prev.includes(groupId) ? prev.filter((x) => x !== groupId) : [...prev, groupId],
      );
    },
    [onToggleGroup],
  );

  // 解析聚焦邻域（仅当目标表仍存在时激活）
  const activeFocus = useMemo(() => {
    if (!focus) return null;
    const rootId = resolveTopLevelTableId(model, focus.tableId);
    if (!rootId) return null;
    return { tableId: rootId, hops: focus.hops };
  }, [focus, model]);

  const focusIds = useMemo(
    () => (activeFocus ? collectNeighborhood(model, activeFocus.tableId, activeFocus.hops) : null),
    [activeFocus, model],
  );

  const effectiveMode = effectiveCanvasMode(viewMode, tables.length);

  const { groups, summaryEdges, tableToGroup } = useMemo(
    () => buildCanvasGroups(model, sections),
    [model, sections],
  );
  const expandedSet = useMemo(() => new Set(activeExpanded), [activeExpanded]);
  const expandedGroupsList = useMemo(
    () => groups.filter((g) => expandedSet.has(g.id)),
    [groups, expandedSet],
  );
  const collapsedGroups = useMemo(
    () => (effectiveMode === 'sections' && !activeFocus ? groups.filter((g) => !expandedSet.has(g.id)) : []),
    [effectiveMode, activeFocus, groups, expandedSet],
  );

  const summaryGridPos = useMemo(() => {
    const cols = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(Math.max(1, collapsedGroups.length)))));
    const map = new Map<string, { x: number; y: number }>();
    collapsedGroups.forEach((g, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      map.set(g.id, { x: col * (SUMMARY_W + 64), y: row * (SUMMARY_H + 56) });
    });
    return map;
  }, [collapsedGroups]);

  const groupPos = useCallback(
    (groupId: string) => {
      const nodeId = `${SUMMARY_NODE_PREFIX}${groupId}`;
      return dragging[nodeId] ?? summaryPositions[nodeId] ?? summaryGridPos.get(groupId);
    },
    [dragging, summaryPositions, summaryGridPos],
  );

  // 当前视图应当渲染并布局的表（性能关键：折叠时不含未展开表，不触发 elkjs）
  const visibleTables = useMemo(() => {
    if (focusIds) return tables.filter((tb) => focusIds.has(tb.id));
    if (effectiveMode === 'flat') return tables;
    if (expandedGroupsList.length === 0) return [];
    const visibleIds = new Set<string>();
    for (const g of expandedGroupsList) for (const tid of g.tableIds) visibleIds.add(tid);
    return tables.filter((tb) => visibleIds.has(tb.id));
  }, [focusIds, effectiveMode, tables, expandedGroupsList]);

  const visibleTableIds = useMemo(() => new Set(visibleTables.map((tb) => tb.id)), [visibleTables]);
  const savedPos = useCallback((id: string) => layout[id] ?? localFallback[id], [layout, localFallback]);
  const pos = useCallback(
    (id: string) => dragging[id] ?? layout[id] ?? localFallback[id],
    [dragging, layout, localFallback],
  );

  // 仅对当前可见且尚未拥有坐标的表执行自动布局
  useEffect(() => {
    const missing = visibleTables.filter((tb) => !savedPos(tb.id));
    if (!missing.length) return;
    let alive = true;
    const occupied: Layout = {};
    for (const tb of visibleTables) {
      const p = savedPos(tb.id);
      if (p) occupied[tb.id] = p;
    }
    for (const g of collapsedGroups) {
      const gp = summaryPositions[`${SUMMARY_NODE_PREFIX}${g.id}`] ?? summaryGridPos.get(g.id);
      if (gp) occupied[`${SUMMARY_NODE_PREFIX}${g.id}`] = gp;
    }
    void autoLayout(model, missing, occupied).then((l) => {
      if (!alive || !Object.keys(l).length) return;
      if (readOnly) {
        setLocalFallback((prev) => ({ ...prev, ...l }));
      } else {
        onMove(l);
      }
      fitted.current = false;
    });
    return () => {
      alive = false;
    };
  }, [visibleTables, savedPos, collapsedGroups, summaryPositions, summaryGridPos, model, readOnly, onMove]);

  // 点击“自动布局”时仅对当前可见表重新布局；在纯汇总视图下重置本地卡片网格坐标
  const latest = useRef({
    model,
    visibleTables,
    collapsedGroups,
    summaryPositions,
    summaryGridPos,
    onMove,
    readOnly,
  });
  useLayoutEffect(() => {
    latest.current = {
      model,
      visibleTables,
      collapsedGroups,
      summaryPositions,
      summaryGridPos,
      onMove,
      readOnly,
    };
  });
  useEffect(() => {
    if (!relayout) return;
    let alive = true;
    const {
      model: m,
      visibleTables: vis,
      collapsedGroups: collapsed,
      summaryPositions: sumPos,
      summaryGridPos: gridPos,
      onMove: move,
      readOnly: ro,
    } = latest.current;
    if (!vis.length) {
      setSummaryPositions({});
      fitted.current = false;
      return;
    }
    const fixed: Layout = {};
    for (const g of collapsed) {
      const gp = sumPos[`${SUMMARY_NODE_PREFIX}${g.id}`] ?? gridPos.get(g.id);
      if (gp) fixed[`${SUMMARY_NODE_PREFIX}${g.id}`] = gp;
    }
    void autoLayout(m, vis, fixed).then((l) => {
      if (!alive || !Object.keys(l).length) return;
      if (ro) setLocalFallback((prev) => ({ ...prev, ...l }));
      else move(l);
      fitted.current = false;
    });
    return () => {
      alive = false;
    };
  }, [relayout]);

  // 切换模式、聚焦目标、跳数或展开状态时重新触发一次适配视角
  const expandedKey = useMemo(() => [...activeExpanded].sort().join(','), [activeExpanded]);
  const fitContextKey = activeFocus
    ? `focus:${activeFocus.tableId}:${activeFocus.hops}`
    : `${effectiveMode}:${expandedKey}:${groups.length}`;
  const prevFitKey = useRef(fitContextKey);
  useEffect(() => {
    if (prevFitKey.current !== fitContextKey) {
      prevFitKey.current = fitContextKey;
      fitted.current = false;
    }
  }, [fitContextKey]);

  const tableNodes: TableNode[] = useMemo(() => {
    if (!visibleTables.length) return [];
    const fkCols = new Set(all(model, 'foreignKey').flatMap((f) => f.columns));
    const pkCols = new Set(all(model, 'primaryKey').flatMap((p) => p.columns));
    const uqCols = new Set(
      all(model, 'unique')
        .filter((u) => u.columns.length === 1)
        .flatMap((u) => u.columns),
    );
    const parts = new Map<string, number>();
    for (const tb of all(model, 'table'))
      if (tb.partitionOf) parts.set(tb.partitionOf.parent, (parts.get(tb.partitionOf.parent) ?? 0) + 1);
    return visibleTables
      .filter((tb) => pos(tb.id))
      .map((tb) => {
        const partSpec = tb.partitionBy ? resolvePartitionBy(model, tb) : null;
        const partStrategy = partSpec
          ? partSpec.strategy.toUpperCase()
          : typeof tb.partitionBy === 'string'
            ? (tb.partitionBy.trim().split(/\s+/)[0]?.toUpperCase() ?? null)
            : null;
        const partKeySet = new Set(tb.partitionBy ? partitionKeyColumns(model, tb).all : []);
        return {
          id: tb.id,
          type: 'table',
          position: pos(tb.id)!,
          selected: tb.id === selected,
          data: {
            table: tb,
            schema: model.objects[tb.parent]?.name ?? '',
            defaultSchema: defaultSchemaOf(model),
            columns: columnsOf(model, tb.id).map((c) => ({
              id: c.id,
              name: c.name,
              type: shortType(typeLabel(model, c)),
              isEnum: !!c.typeRef,
              key: pkCols.has(c.id) ? 'PK' : fkCols.has(c.id) ? 'FK' : uqCols.has(c.id) ? 'UQ' : '',
              notNull: c.notNull || pkCols.has(c.id),
              isPartKey: partKeySet.has(c.id),
            })),
            partitions: parts.get(tb.id) ?? 0,
            partitionStrategy: partStrategy,
            selected: tb.id === selected,
          },
        };
      });
  }, [model, visibleTables, pos, selected]);

  const summaryNodes: SummaryNode[] = useMemo(() => {
    if (!collapsedGroups.length) return [];
    const hasSections = sections.length > 0;
    return collapsedGroups
      .filter((g) => groupPos(g.id))
      .map((g) => ({
        id: `${SUMMARY_NODE_PREFIX}${g.id}`,
        type: 'sectionSummary',
        position: groupPos(g.id)!,
        selectable: false,
        data: {
          group: g,
          hasSections,
          onExpand: toggleGroup,
        },
      }));
  }, [collapsedGroups, sections.length, groupPos, toggleGroup]);

  const nodes: CanvasNode[] = useMemo(
    () => (summaryNodes.length === 0 ? tableNodes : [...summaryNodes, ...tableNodes]),
    [summaryNodes, tableNodes],
  );

  // 当前视图中所有可见表（及汇总卡片）就位之后适配一次视图
  useEffect(() => {
    if (!flow || fitted.current || nodes.length === 0 || visibleTables.some((tb) => !savedPos(tb.id))) return;
    fitted.current = true;
    requestAnimationFrame(() => void flow.fitView({ padding: 0.15, maxZoom: 1 }));
  }, [flow, nodes.length, visibleTables, savedPos, fitContextKey]);

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    const fks = all(model, 'foreignKey');

    // 1. 可见表之间的精确列级外键连线
    for (const f of fks) {
      if (!visibleTableIds.has(f.parent) || !visibleTableIds.has(f.refTable)) continue;
      const a = pos(f.parent);
      const b = pos(f.refTable);
      if (!a || !b) continue;
      const self = f.parent === f.refTable;
      const toRight = !self && a.x + NODE_W / 2 < b.x + NODE_W / 2;
      const active = f.parent === selected || f.refTable === selected;
      out.push({
        id: f.id,
        source: f.parent,
        target: f.refTable,
        sourceHandle: `${f.columns[0]}-${self || toRight ? 'sr' : 'sl'}`,
        targetHandle: `${f.refColumns[0]}-${self || !toRight ? 'tr' : 'tl'}`,
        markerStart: 'dowel-many',
        markerEnd: 'dowel-one',
        style: { strokeWidth: 1.5, stroke: active ? 'var(--primary)' : 'var(--edge)' },
        zIndex: active ? 1 : 0,
      });
    }

    if (effectiveMode !== 'sections' || activeFocus) return out;

    // 2. 折叠汇总卡片之间的跨板块 / 跨 Schema 汇总边
    for (const se of summaryEdges) {
      if (expandedSet.has(se.sourceGroupId) || expandedSet.has(se.targetGroupId)) continue;
      const a = groupPos(se.sourceGroupId);
      const b = groupPos(se.targetGroupId);
      if (!a || !b) continue;
      const toRight = a.x + SUMMARY_W / 2 <= b.x + SUMMARY_W / 2;
      out.push({
        id: se.id,
        source: `${SUMMARY_NODE_PREFIX}${se.sourceGroupId}`,
        target: `${SUMMARY_NODE_PREFIX}${se.targetGroupId}`,
        sourceHandle: toRight ? 'sr' : 'sl',
        targetHandle: toRight ? 'tl' : 'tr',
        markerEnd: 'dowel-one',
        label: String(se.count),
        labelStyle: { fill: 'var(--text-2)', fontSize: 11, fontFamily: 'var(--font-code)' },
        labelBgStyle: { fill: 'var(--surface)', fillOpacity: 0.9 },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
        style: { strokeWidth: 1.5, stroke: 'var(--edge)', strokeDasharray: '5 4' },
      });
    }

    // 3. 已展开可见表与折叠汇总卡片之间的跨边界汇总边（每对聚合为一条虚线）
    const crossBoundary = new Map<
      string,
      {
        source: string;
        target: string;
        tablePos: { x: number; y: number };
        groupPos: { x: number; y: number };
        tableIsSource: boolean;
        colId: string;
        count: number;
      }
    >();
    for (const f of fks) {
      const srcVis = visibleTableIds.has(f.parent);
      const dstVis = visibleTableIds.has(f.refTable);
      if (srcVis === dstVis) continue;
      if (srcVis) {
        const dstGroup = tableToGroup.get(f.refTable);
        if (!dstGroup || expandedSet.has(dstGroup)) continue;
        const tp = pos(f.parent);
        const gp = groupPos(dstGroup);
        if (!tp || !gp || !f.columns[0]) continue;
        const key = `${f.parent}->${dstGroup}`;
        const cur = crossBoundary.get(key);
        if (cur) cur.count += 1;
        else
          crossBoundary.set(key, {
            source: f.parent,
            target: `${SUMMARY_NODE_PREFIX}${dstGroup}`,
            tablePos: tp,
            groupPos: gp,
            tableIsSource: true,
            colId: f.columns[0],
            count: 1,
          });
      } else {
        const srcGroup = tableToGroup.get(f.parent);
        if (!srcGroup || expandedSet.has(srcGroup)) continue;
        const gp = groupPos(srcGroup);
        const tp = pos(f.refTable);
        if (!gp || !tp || !f.refColumns[0]) continue;
        const key = `${srcGroup}->${f.refTable}`;
        const cur = crossBoundary.get(key);
        if (cur) cur.count += 1;
        else
          crossBoundary.set(key, {
            source: `${SUMMARY_NODE_PREFIX}${srcGroup}`,
            target: f.refTable,
            tablePos: tp,
            groupPos: gp,
            tableIsSource: false,
            colId: f.refColumns[0],
            count: 1,
          });
      }
    }
    for (const [key, item] of crossBoundary) {
      const tableLeftOfGroup = item.tablePos.x + NODE_W / 2 <= item.groupPos.x + SUMMARY_W / 2;
      out.push({
        id: `cross:${key}`,
        source: item.source,
        target: item.target,
        sourceHandle: item.tableIsSource
          ? `${item.colId}-${tableLeftOfGroup ? 'sr' : 'sl'}`
          : tableLeftOfGroup
            ? 'sl'
            : 'sr',
        targetHandle: item.tableIsSource
          ? tableLeftOfGroup
            ? 'tl'
            : 'tr'
          : `${item.colId}-${tableLeftOfGroup ? 'tr' : 'tl'}`,
        markerEnd: 'dowel-one',
        label: String(item.count),
        labelStyle: { fill: 'var(--text-2)', fontSize: 11, fontFamily: 'var(--font-code)' },
        labelBgStyle: { fill: 'var(--surface)', fillOpacity: 0.9 },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
        style: { strokeWidth: 1.5, stroke: 'var(--edge)', strokeDasharray: '5 4' },
      });
    }

    return out;
  }, [
    model,
    visibleTableIds,
    pos,
    selected,
    effectiveMode,
    activeFocus,
    summaryEdges,
    expandedSet,
    groupPos,
    tableToGroup,
  ]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    for (const ch of changes)
      if (ch.type === 'position' && ch.position) setDragging((d) => ({ ...d, [ch.id]: ch.position! }));
  }, []);

  const showViewBar =
    !activeFocus &&
    Boolean(onChangeViewMode) &&
    (tables.length > LARGE_SCHEMA_THRESHOLD || sections.length > 0 || viewMode !== 'auto');

  const focusTableObj = activeFocus ? model.objects[activeFocus.tableId] : undefined;
  const focusTableLabel = useMemo(() => {
    if (!focusTableObj || focusTableObj.kind !== 'table') return '';
    const schemaName = model.objects[focusTableObj.parent]?.name ?? '';
    const defSchema = defaultSchemaOf(model);
    return schemaName && schemaName !== defSchema
      ? `${schemaName}.${focusTableObj.name}`
      : focusTableObj.name;
  }, [focusTableObj, model]);

  return (
    <ReactFlow<CanvasNode>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={(_, node) => {
        if (node.type === 'sectionSummary') {
          setSummaryPositions((prev) => ({ ...prev, [node.id]: node.position }));
        } else {
          onMove({ [node.id]: node.position });
        }
        setDragging((d) => {
          const { [node.id]: _x, ...rest } = d;
          return rest;
        });
      }}
      onNodeClick={(_, n) => {
        if (n.type === 'table') onSelect(n.id);
      }}
      onPaneClick={() => onSelect(null)}
      onInit={setFlow}
      minZoom={0.1}
      maxZoom={2}
    >
      <Markers />
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
      {activeFocus && (
        <Panel
          position="top-center"
          className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-surface px-2.5 py-1 shadow-[var(--shadow-sm)]"
        >
          <Focus size={14} aria-hidden="true" className="text-primary-text" />
          <span className="text-xs text-text-2">{t('sec.focusLabel')}</span>
          <span className="font-mono text-sm font-semibold">{focusTableLabel}</span>
          <span className="badge font-mono">{t('sec.tableCount', { count: visibleTables.length })}</span>
          <div
            role="tablist"
            {...({ focusgroup: 'tablist nomemory' } as object)}
            aria-label={t('sec.hopsLabel')}
            className="seg"
          >
            {([1, 2] as const).map((h) => (
              <button
                key={h}
                type="button"
                role="tab"
                aria-selected={activeFocus.hops === h}
                {...(activeFocus.hops === h ? { focusgroupstart: '' } : {})}
                onFocus={() => onChangeFocus?.({ tableId: activeFocus.tableId, hops: h })}
                onClick={() => onChangeFocus?.({ tableId: activeFocus.tableId, hops: h })}
              >
                {t(h === 1 ? 'sec.hop1' : 'sec.hop2')}
              </button>
            ))}
          </div>
          <button type="button" className="btn sm" onClick={() => onChangeFocus?.(null)}>
            {t('sec.exitFocus')}
          </button>
        </Panel>
      )}
      {showViewBar && (
        <Panel position="top-right" className="flex max-w-[460px] flex-wrap items-center justify-end gap-1.5">
          {effectiveMode === 'sections' && expandedGroupsList.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 shadow-[var(--shadow-sm)]">
              {expandedGroupsList.map((g) => {
                const label = g.kind === 'unassigned' ? t('sec.unassigned') : g.name;
                return (
                  <button
                    key={g.id}
                    type="button"
                    className="btn ghost sm gap-1.5 px-1.5 text-xs"
                    aria-label={t('sec.collapseGroupLabel', { name: label })}
                    onClick={() => toggleGroup(g.id)}
                  >
                    <span
                      aria-hidden="true"
                      className="size-2 rounded-full"
                      style={{ background: g.color ? sectionColorCssVar(g.color) : 'var(--border-strong)' }}
                    />
                    <span className="max-w-[110px] truncate">{label}</span>
                    <span className="text-text-3">{t('sec.collapse')}</span>
                  </button>
                );
              })}
              {expandedGroupsList.length > 1 && onCollapseAllGroups && (
                <button type="button" className="btn ghost sm px-1.5 text-xs" onClick={onCollapseAllGroups}>
                  {t('sec.collapseAll')}
                </button>
              )}
            </div>
          )}
          <div
            role="tablist"
            {...({ focusgroup: 'tablist nomemory' } as object)}
            aria-label={t('sec.canvasViewMode')}
            className="seg floating"
          >
            {(['sections', 'flat'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={effectiveMode === m}
                {...(effectiveMode === m ? { focusgroupstart: '' } : {})}
                onFocus={() => onChangeViewMode!(m)}
                onClick={() => onChangeViewMode!(m)}
              >
                {t(m === 'sections' ? 'sec.viewSections' : 'sec.viewFlat')}
              </button>
            ))}
          </div>
        </Panel>
      )}
      <ZoomPanel />
      <MiniMap
        pannable
        zoomable
        nodeClassName={(n) => (n.id === selected ? 'selected' : '')}
        nodeBorderRadius={2}
      />
    </ReactFlow>
  );
};
