// 画布：每张表一个节点（DESIGN.md：画布），外键连线连到具体的列行；拖动后同步位置。
import { all, columnsOf, type Model, type Table } from '@dowel/core';
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
import { Maximize, Table2, ZoomIn, ZoomOut } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Layout } from '../workspace.ts';
import { IconButton } from './ui.tsx';

type Col = {
  id: string;
  name: string;
  type: string;
  isEnum: boolean;
  key: 'PK' | 'FK' | 'UQ' | '';
  notNull: boolean;
};
type TableData = { table: Table; schema: string; columns: Col[]; partitions: number; selected: boolean };
type TableNode = Node<TableData, 'table'>;

const NODE_W = 250;
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

const TableNodeView = memo(({ data }: NodeProps<TableNode>) => (
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
        {data.schema !== 'public' && <span className="font-normal text-text-3">{data.schema}.</span>}
        {data.table.name}
      </span>
      {data.partitions > 0 && <span className="badge font-sans">{data.partitions} 个分区</span>}
    </div>
    {data.columns.map((c) => (
      <div key={c.id} style={{ height: ROW_H }} className="relative flex items-center gap-1.5 px-2.5 text-sm">
        <RowHandles id={c.id} />
        <span className={`w-5 text-[10px] font-semibold ${KEY_CLASS[c.key]}`}>{c.key}</span>
        <span className="min-w-0 flex-1 truncate">
          {c.name}
          {!c.notNull && <span className="text-text-3">?</span>}
        </span>
        <span className={`truncate text-xs ${c.isEnum ? 'text-enum' : 'text-text-3'}`}>{c.type}</span>
      </div>
    ))}
    {data.columns.length === 0 && <div style={{ height: ROW_H }} />}
  </div>
));

const nodeTypes = { table: TableNodeView };

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

/** 用 elkjs 计算还没有位置的表的位置 */
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

export const Canvas = ({
  model,
  layout,
  selected,
  onSelect,
  onMove,
  relayout,
}: {
  model: Model;
  layout: Layout;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onMove: (l: Layout) => void;
  /** 变化时对所有表重新自动布局 */
  relayout: number;
}) => {
  const [dragging, setDragging] = useState<Layout>({});
  const [flow, setFlow] = useState<ReactFlowInstance<TableNode> | null>(null);
  const fitted = useRef(false);
  const tables = useMemo(() => all(model, 'table').filter((t) => !t.partitionOf), [model]);

  // 还没有位置的表：自动布局一次，并同步给其他人
  useEffect(() => {
    const missing = tables.filter((t) => !layout[t.id]);
    if (!missing.length) return;
    let alive = true;
    void autoLayout(model, missing, layout).then((l) => {
      if (!alive || !Object.keys(l).length) return;
      onMove(l);
      fitted.current = false; // 新放上画布的表，重新适配视图
    });
    return () => {
      alive = false;
    };
  }, [tables, layout, model, onMove]);

  // 点击“自动布局”时对所有表重新布局；用 ref 取最新的模型，effect 只随点击次数触发
  const latest = useRef({ model, tables, onMove });
  latest.current = { model, tables, onMove };
  useEffect(() => {
    if (!relayout) return;
    const { model: m, tables: ts, onMove: move } = latest.current;
    void autoLayout(m, ts, {}).then((l) => {
      move(l);
      fitted.current = false;
    });
  }, [relayout]);

  // 所有表都有位置之后适配一次视图
  useEffect(() => {
    if (!flow || fitted.current || tables.some((t) => !layout[t.id])) return;
    fitted.current = true;
    requestAnimationFrame(() => void flow.fitView({ padding: 0.15, maxZoom: 1 }));
  }, [flow, tables, layout]);

  const pos = useCallback((id: string) => dragging[id] ?? layout[id], [dragging, layout]);

  const nodes: TableNode[] = useMemo(() => {
    const fkCols = new Set(all(model, 'foreignKey').flatMap((f) => f.columns));
    const pkCols = new Set(all(model, 'primaryKey').flatMap((p) => p.columns));
    const uqCols = new Set(
      all(model, 'unique')
        .filter((u) => u.columns.length === 1)
        .flatMap((u) => u.columns),
    );
    const parts = new Map<string, number>();
    for (const t of all(model, 'table'))
      if (t.partitionOf) parts.set(t.partitionOf.parent, (parts.get(t.partitionOf.parent) ?? 0) + 1);
    // 还没算出位置的表先不画，避免叠在原点
    return tables
      .filter((t) => pos(t.id))
      .map((t) => ({
        id: t.id,
        type: 'table',
        position: pos(t.id)!,
        selected: t.id === selected,
        data: {
          table: t,
          schema: model.objects[t.parent]?.name ?? '',
          columns: columnsOf(model, t.id).map((c) => ({
            id: c.id,
            name: c.name,
            type: shortType(typeLabel(model, c)),
            isEnum: !!c.typeRef,
            key: pkCols.has(c.id) ? 'PK' : fkCols.has(c.id) ? 'FK' : uqCols.has(c.id) ? 'UQ' : '',
            notNull: c.notNull || pkCols.has(c.id),
          })),
          partitions: parts.get(t.id) ?? 0,
          selected: t.id === selected,
        },
      }));
  }, [model, tables, pos, selected]);

  const edges: Edge[] = useMemo(() => {
    const ids = new Set(tables.map((t) => t.id));
    return all(model, 'foreignKey')
      .filter((f) => ids.has(f.parent) && ids.has(f.refTable) && pos(f.parent) && pos(f.refTable))
      .map((f) => {
        // 被引用的表在右边：从外键表的右侧连到被引用表的左侧；反之亦然；自引用都走右侧
        const a = pos(f.parent)!;
        const b = pos(f.refTable)!;
        const self = f.parent === f.refTable;
        const toRight = !self && a.x + NODE_W / 2 < b.x + NODE_W / 2;
        const active = f.parent === selected || f.refTable === selected;
        return {
          id: f.id,
          source: f.parent,
          target: f.refTable,
          sourceHandle: `${f.columns[0]}-${self || toRight ? 'sr' : 'sl'}`,
          targetHandle: `${f.refColumns[0]}-${self || !toRight ? 'tr' : 'tl'}`,
          markerStart: 'dowel-many',
          markerEnd: 'dowel-one',
          style: { strokeWidth: 1.5, stroke: active ? 'var(--primary)' : 'var(--edge)' },
          zIndex: active ? 1 : 0,
        };
      });
  }, [model, tables, pos, selected]);

  const onNodesChange = useCallback((changes: NodeChange<TableNode>[]) => {
    for (const ch of changes)
      if (ch.type === 'position' && ch.position) setDragging((d) => ({ ...d, [ch.id]: ch.position! }));
  }, []);

  return (
    <ReactFlow<TableNode>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={(_, node) => {
        onMove({ [node.id]: node.position });
        setDragging((d) => {
          const { [node.id]: _x, ...rest } = d;
          return rest;
        });
      }}
      onNodeClick={(_, n) => onSelect(n.id)}
      onPaneClick={() => onSelect(null)}
      onInit={setFlow}
      minZoom={0.1}
      maxZoom={2}
    >
      <Markers />
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
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
