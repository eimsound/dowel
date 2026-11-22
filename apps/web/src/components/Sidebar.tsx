// 左侧对象树：按 Schema / 按板块双视图、搜索、表（分区父表支持展开查看子分区）、枚举、序列、其他（不透明）对象，支持千表虚拟滚动（DESIGN.md：Layout）。
import { type CanvasSection, sectionColorCssVar } from '@dowel/api';
import { buildModelIndex, type Model, type ModelIndex, resolvePartitionBy, type Table } from '@dowel/core';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  FileCode,
  Focus,
  Hash,
  Layers,
  List,
  Plus,
  Search,
  Settings2,
  Sparkles,
  SquareFunction,
  Table2,
  Zap,
} from 'lucide-react';
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';

import { defaultSchemaOf, dialectUiSpec } from '../dialects.ts';
import type { SidebarGrouping } from '../sections.ts';
import { cx, IconButton } from './ui.tsx';

export interface SelectedStore {
  getSnapshot: () => string | null;
  subscribe: (fn: () => void) => () => void;
}

const NOOP_SUBSCRIBE = () => () => {};

const useIsSelected = (id: string, selectedProp: string | null, selectedStore?: SelectedStore): boolean =>
  useSyncExternalStore(
    selectedStore ? selectedStore.subscribe : NOOP_SUBSCRIBE,
    () => (selectedStore ? selectedStore.getSnapshot() : selectedProp) === id,
  );

const VIRTUAL_THRESHOLD = 80;
const OVERSCAN_PX = 360;
const GROUP_ROW_H = 30;
const TABLE_ROW_H = 28;
const CHILD_ROW_H = 26;
const EMPTY_ROW_H = 24;
const NO_MATCH_ROW_H = 52;

const OPAQUE_ICON: Record<string, typeof Eye> = {
  view: Eye,
  materializedView: Eye,
  function: SquareFunction,
  procedure: SquareFunction,
  aggregate: SquareFunction,
  trigger: Zap,
};

interface TableNode {
  table: Table;
  label: string;
  labelLower: string;
  strat: string | null;
  totalChildren: number;
  children: TableNode[];
  hasSelfMatch: boolean;
  forceExpand: boolean;
}

type SidebarRow =
  | {
      kind: 'group';
      key: string;
      groupKey: string;
      title: string;
      dotColor?: string;
      count: number;
      open: boolean;
      hasAction: boolean;
      action?: ReactNode;
      height: number;
    }
  | {
      kind: 'table';
      key: string;
      node: TableNode;
      depth: number;
      isOpen: boolean;
      isFocused: boolean;
      height: number;
    }
  | { kind: 'empty'; key: string; text: string; height: number }
  | {
      kind: 'item';
      key: string;
      id: string;
      label: string;
      icon: ReactNode;
      hint?: string;
      height: number;
    }
  | { kind: 'noMatch'; key: string; text: string; height: number };

const calcVisibleWindow = (scrollTop: number, viewportHeight: number, offsets: number[]) => {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  const minY = Math.max(0, scrollTop - OVERSCAN_PX);
  const maxY = scrollTop + viewportHeight + OVERSCAN_PX;

  let lo = 0;
  let hi = count - 1;
  let start = count;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid + 1]! >= minY) {
      start = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  lo = start;
  hi = count - 1;
  let end = start;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid]! <= maxY) {
      end = mid + 1;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { start: Math.max(0, start), end: Math.min(count, Math.max(start, end)) };
};

const GroupRow = memo(
  ({
    groupKey,
    title,
    dotColor,
    count,
    open,
    action,
    onToggle,
  }: {
    groupKey: string;
    title: string;
    dotColor?: string;
    count: number;
    open: boolean;
    action?: ReactNode;
    onToggle: (key: string) => void;
  }) => (
    <li className="flex h-[30px] items-start">
      <div className={cx('flex h-[26px] w-full items-center gap-0.5', Boolean(action) && 'pr-1')}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle(groupKey)}
          className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-sm px-1.5 text-xs font-semibold text-text-3 hover:text-text-2"
        >
          {open ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          {dotColor && (
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ background: dotColor }}
            />
          )}
          <span className="min-w-0 truncate">{title}</span>
          <span className="count ml-auto">{count}</span>
        </button>
        {action}
      </div>
    </li>
  ),
);

const ItemRow = memo(
  ({
    id,
    label,
    icon,
    hint,
    selectedProp,
    selectedStore,
    onSelect,
  }: {
    id: string;
    label: string;
    icon: ReactNode;
    hint?: string;
    selectedProp: string | null;
    selectedStore?: SelectedStore;
    onSelect: (id: string) => void;
  }) => {
    const active = useIsSelected(id, selectedProp, selectedStore);
    return (
      <li>
        <button
          type="button"
          onClick={() => onSelect(id)}
          aria-current={active ? 'true' : undefined}
          className="flex h-[var(--row-h)] w-full items-center gap-2 rounded-sm pr-2 pl-[22px] text-left font-mono text-sm text-text-2 transition-colors hover:bg-surface-hover aria-[current]:bg-primary-soft aria-[current]:font-medium aria-[current]:text-primary-text [&>svg]:text-text-3 aria-[current]:[&>svg]:text-primary-text"
        >
          {icon}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {hint && <span className="shrink-0 font-sans text-xs text-text-3">{hint}</span>}
        </button>
      </li>
    );
  },
);

const TableRow = memo(
  ({
    node,
    depth,
    tabBase,
    isOpen,
    isFocused,
    selectedProp,
    selectedStore,
    onSelect,
    onToggleExpand,
    onFocusTable,
    onExitFocus,
  }: {
    node: TableNode;
    depth: number;
    tabBase: string;
    isOpen: boolean;
    isFocused: boolean;
    selectedProp: string | null;
    selectedStore?: SelectedStore;
    onSelect: (id: string) => void;
    onToggleExpand: (id: string, nextOpen: boolean) => void;
    onFocusTable?: (tableId: string) => void;
    onExitFocus?: () => void;
  }) => {
    const { t } = useTranslation();
    const { table, label, strat, totalChildren, children } = node;
    const isSelected = useIsSelected(table.id, selectedProp, selectedStore);
    const labelId = `${tabBase}-tbl-${table.id}`;
    const hasChildren = children.length > 0;
    const isChild = depth > 0;
    const indentPx = depth * 14;

    const focusBtn =
      depth === 0 && onFocusTable ? (
        <IconButton
          label={t('sec.focusRowAction')}
          size="sm"
          aria-pressed={isFocused}
          aria-describedby={labelId}
          className={cx(
            'shrink-0',
            isFocused
              ? 'text-primary-text opacity-100'
              : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100',
          )}
          onClick={() => (isFocused ? onExitFocus?.() : onFocusTable(table.id))}
        >
          <Focus size={13} aria-hidden="true" />
        </IconButton>
      ) : null;

    if (depth === 0 && !strat && totalChildren === 0) {
      return (
        <li className="group flex h-[var(--row-h)] items-center pr-1">
          <button
            type="button"
            onClick={() => onSelect(table.id)}
            aria-current={isSelected ? 'true' : undefined}
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm pr-2 pl-[22px] text-left font-mono text-sm text-text-2 transition-colors hover:bg-surface-hover aria-[current]:bg-primary-soft aria-[current]:font-medium aria-[current]:text-primary-text [&>svg]:text-text-3 aria-[current]:[&>svg]:text-primary-text"
          >
            <Table2 size={16} aria-hidden="true" />
            <span id={labelId} className="min-w-0 flex-1 truncate">
              {label}
            </span>
          </button>
          {focusBtn}
        </li>
      );
    }

    return (
      <li>
        <div
          className={isChild ? 'flex h-[26px] items-center' : 'group flex h-[var(--row-h)] items-center pr-1'}
          style={indentPx ? { paddingLeft: `${indentPx}px` } : undefined}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={isOpen}
              aria-label={t('part.togglePartitions', { name: table.name })}
              onClick={() => onToggleExpand(table.id, !isOpen)}
              className="flex size-[22px] shrink-0 items-center justify-center rounded-sm text-text-3 hover:bg-surface-hover hover:text-text-2"
            >
              {isOpen ? (
                <ChevronDown size={13} aria-hidden="true" />
              ) : (
                <ChevronRight size={13} aria-hidden="true" />
              )}
            </button>
          ) : (
            <span className="w-[22px] shrink-0" aria-hidden="true" />
          )}
          <button
            type="button"
            onClick={() => onSelect(table.id)}
            aria-current={isSelected ? 'true' : undefined}
            className={
              isChild
                ? 'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm pr-2 pl-0.5 text-left font-mono text-xs text-text-3 transition-colors hover:bg-surface-hover hover:text-text-2 aria-[current]:bg-primary-soft aria-[current]:text-primary-text'
                : 'flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm pr-2 pl-0.5 text-left font-mono text-sm text-text-2 transition-colors hover:bg-surface-hover aria-[current]:bg-primary-soft aria-[current]:font-medium aria-[current]:text-primary-text [&>svg]:text-text-3 aria-[current]:[&>svg]:text-primary-text'
            }
          >
            {isChild ? (
              <Layers size={12} aria-hidden="true" className="shrink-0" />
            ) : (
              <Table2 size={16} aria-hidden="true" />
            )}
            <span id={depth === 0 ? labelId : undefined} className="min-w-0 flex-1 truncate">
              {label}
            </span>
            {strat && (
              <span className="shrink-0 font-mono text-[11px] text-text-3">
                {strat} · {totalChildren}
              </span>
            )}
          </button>
          {focusBtn}
        </div>
      </li>
    );
  },
);

const byName = <T extends { name: string }>(xs: readonly T[]) =>
  [...xs].sort((a, b) => a.name.localeCompare(b.name));

const filterTableNode = (node: TableNode, qLower: string, ancestorMatched: boolean): TableNode | null => {
  const selfMatched = node.labelLower.includes(qLower);
  const visibleChildren = node.children
    .map((ch) => filterTableNode(ch, qLower, ancestorMatched || selfMatched))
    .filter((x): x is TableNode => x !== null);
  if (!ancestorMatched && !selfMatched && visibleChildren.length === 0) return null;
  const childHasSelfMatch = visibleChildren.some((ch) => ch.hasSelfMatch);
  return {
    ...node,
    children: visibleChildren,
    hasSelfMatch: selfMatched || childHasSelfMatch,
    forceExpand: childHasSelfMatch,
  };
};

const EMPTY_TABLE_NODES: TableNode[] = [];
const EMPTY_SECTION_LIST: { section: CanvasSection; nodes: TableNode[] }[] = [];

export const Sidebar = memo(
  ({
    model,
    selected = null,
    selectedStore,
    modelIndex,
    onSelect,
    onAddSequence,
    sections = [],
    grouping,
    defaultGrouping,
    onChangeGrouping,
    readOnly = false,
    onOpenSectionManager,
    onFocusTable,
    onExitFocus,
    focusedTableId = null,
  }: {
    model: Model;
    selected?: string | null;
    selectedStore?: SelectedStore;
    modelIndex?: ModelIndex;
    onSelect: (id: string) => void;
    onAddSequence?: () => void;
    sections?: CanvasSection[];
    grouping?: SidebarGrouping;
    defaultGrouping?: SidebarGrouping;
    onChangeGrouping?: (g: SidebarGrouping) => void;
    readOnly?: boolean;
    onOpenSectionManager?: (mode: 'manage' | 'suggest') => void;
    onFocusTable?: (tableId: string) => void;
    onExitFocus?: () => void;
    focusedTableId?: string | null;
  }) => {
    const { t } = useTranslation();
    const [localGrouping, setLocalGrouping] = useState<SidebarGrouping>(defaultGrouping ?? 'schema');
    const activeGrouping = grouping ?? localGrouping;
    const [q, setQ] = useState('');
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
    const tabBase = useId();
    const defSchema = defaultSchemaOf(model);
    const uiSpec = dialectUiSpec(model.dialect);
    const effectiveIndex = useMemo(() => modelIndex ?? buildModelIndex(model), [model, modelIndex]);
    const qLower = q.trim().toLowerCase();

    const fullTree = useMemo(() => {
      const schemaName = (id: string) => model.objects[id]?.name ?? '';
      const qname = (o: { parent: string; name: string }) =>
        schemaName(o.parent) === defSchema ? o.name : `${schemaName(o.parent)}.${o.name}`;
      const strategyLabel = (tb: Table): string | null => {
        if (!tb.partitionBy) return null;
        const spec = resolvePartitionBy(model, tb);
        if (spec) return spec.strategy.toUpperCase();
        return typeof tb.partitionBy === 'string'
          ? (tb.partitionBy.trim().split(/\s+/)[0]?.toUpperCase() ?? null)
          : null;
      };
      const buildNode = (tb: Table, seen: Set<string>): TableNode | null => {
        if (seen.has(tb.id)) return null;
        seen.add(tb.id);
        const label = qname(tb);
        const rawChildren = byName(effectiveIndex.partitionsRef(tb.id));
        const children = rawChildren
          .map((ch) => buildNode(ch, seen))
          .filter((x): x is TableNode => x !== null);
        return {
          table: tb,
          label,
          labelLower: label.toLowerCase(),
          strat: strategyLabel(tb),
          totalChildren: rawChildren.length,
          children,
          hasSelfMatch: false,
          forceExpand: false,
        };
      };
      const topLevelTables = byName(effectiveIndex.allRef('table').filter((x) => !x.partitionOf));
      return topLevelTables.map((x) => buildNode(x, new Set())).filter((x): x is TableNode => x !== null);
    }, [model, effectiveIndex, defSchema]);

    const filteredTables = useMemo(() => {
      if (!qLower) return fullTree;
      return fullTree.map((n) => filterTableNode(n, qLower, false)).filter((x): x is TableNode => x !== null);
    }, [fullTree, qLower]);

    const fullSectionBuckets = useMemo(() => {
      const nodeById = new Map(fullTree.map((n) => [n.table.id, n]));
      const assigned = new Set<string>();
      const list = sections.map((sec) => {
        const nodes: TableNode[] = [];
        for (const tid of sec.tables) {
          assigned.add(tid);
          const node = nodeById.get(tid);
          if (node) nodes.push(node);
        }
        nodes.sort((a, b) => a.label.localeCompare(b.label));
        return { section: sec, nodes };
      });
      const unassignedNodes = fullTree.filter((n) => !assigned.has(n.table.id));
      return { list, unassignedNodes };
    }, [fullTree, sections]);

    const sectionBuckets = useMemo(() => {
      if (activeGrouping !== 'section') {
        return { list: EMPTY_SECTION_LIST, unassignedNodes: EMPTY_TABLE_NODES };
      }
      if (!qLower) return fullSectionBuckets;
      const filteredById = new Map(filteredTables.map((n) => [n.table.id, n]));
      return {
        list: fullSectionBuckets.list.map((b) => ({
          section: b.section,
          nodes: b.nodes
            .map((n) => filteredById.get(n.table.id))
            .filter((n): n is TableNode => n !== undefined),
        })),
        unassignedNodes: fullSectionBuckets.unassignedNodes
          .map((n) => filteredById.get(n.table.id))
          .filter((n): n is TableNode => n !== undefined),
      };
    }, [activeGrouping, qLower, fullSectionBuckets, filteredTables]);

    const otherGroups = useMemo(() => {
      const schemaName = (id: string) => model.objects[id]?.name ?? '';
      const qname = (o: { parent: string; name: string }) =>
        schemaName(o.parent) === defSchema ? o.name : `${schemaName(o.parent)}.${o.name}`;
      const match = (s: string) => !qLower || s.toLowerCase().includes(qLower);
      const groups: {
        key: string;
        title: string;
        showEmpty?: boolean;
        action?: ReactNode;
        items: { id: string; label: string; icon: ReactNode; hint?: string }[];
      }[] = [
        ...(uiSpec.enums
          ? [
              {
                key: 'other:enums',
                title: t('ws.enums'),
                items: byName(effectiveIndex.allRef('enum')).map((x) => ({
                  id: x.id,
                  label: qname(x),
                  icon: <List size={16} aria-hidden="true" />,
                })),
              },
            ]
          : []),
        ...(uiSpec.sequences
          ? [
              {
                key: 'other:sequences',
                title: t('ws.sequences'),
                showEmpty: Boolean(onAddSequence),
                action: onAddSequence ? (
                  <IconButton label={t('ws.addSequence')} size="sm" onClick={onAddSequence}>
                    <Plus size={13} aria-hidden="true" />
                  </IconButton>
                ) : undefined,
                items: byName(effectiveIndex.allRef('sequence')).map((x) => ({
                  id: x.id,
                  label: qname(x),
                  icon: <Hash size={16} aria-hidden="true" />,
                })),
              },
            ]
          : []),
        {
          key: 'other:opaque',
          title: t('ws.others'),
          items: byName(effectiveIndex.allRef('opaque')).map((x) => {
            const Icon = OPAQUE_ICON[x.objType] ?? FileCode;
            return { id: x.id, label: x.name, hint: x.objType, icon: <Icon size={16} aria-hidden="true" /> };
          }),
        },
      ];
      return groups.map((g) => ({ ...g, items: g.items.filter((i) => match(i.label)) }));
    }, [model, effectiveIndex, uiSpec.enums, uiSpec.sequences, defSchema, qLower, onAddSequence, t]);

    const toggleGroupOpen = useCallback((groupKey: string) => {
      setCollapsedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
    }, []);

    const toggleNodeExpand = useCallback((id: string, nextOpen: boolean) => {
      setExpanded((prev) => ({ ...prev, [id]: nextOpen }));
    }, []);

    const hasSectionMatch =
      sectionBuckets.list.some((b) => b.nodes.length > 0) || sectionBuckets.unassignedNodes.length > 0;

    const rows = useMemo<SidebarRow[]>(() => {
      const out: SidebarRow[] = [];
      const pushTableTree = (prefix: string, node: TableNode, depth: number) => {
        const isOpen = expanded[node.table.id] ?? node.forceExpand;
        out.push({
          kind: 'table',
          key: `${prefix}:tbl:${node.table.id}`,
          node,
          depth,
          isOpen,
          isFocused: focusedTableId === node.table.id,
          height: depth > 0 ? CHILD_ROW_H : TABLE_ROW_H,
        });
        if (node.children.length > 0 && isOpen) {
          for (const ch of node.children) pushTableTree(prefix, ch, depth + 1);
        }
      };

      if (activeGrouping === 'schema') {
        if (filteredTables.length > 0) {
          const gKey = 'schema:tables';
          const open = !collapsedGroups[gKey];
          out.push({
            kind: 'group',
            key: `g:${gKey}`,
            groupKey: gKey,
            title: t('ws.tables'),
            count: filteredTables.length,
            open,
            hasAction: false,
            height: GROUP_ROW_H,
          });
          if (open) {
            for (const node of filteredTables) pushTableTree('schema', node, 0);
          }
        }
      } else {
        for (const { section, nodes } of sectionBuckets.list) {
          if (qLower && nodes.length === 0) continue;
          const gKey = `sec:${section.id}`;
          const open = !collapsedGroups[gKey];
          out.push({
            kind: 'group',
            key: `g:${gKey}`,
            groupKey: gKey,
            title: section.name,
            dotColor: sectionColorCssVar(section.color),
            count: nodes.length,
            open,
            hasAction: false,
            height: GROUP_ROW_H,
          });
          if (open) {
            if (nodes.length > 0) {
              for (const node of nodes) pushTableTree(section.id, node, 0);
            } else {
              out.push({
                kind: 'empty',
                key: `empty:${section.id}`,
                text: t('sec.emptySection'),
                height: EMPTY_ROW_H,
              });
            }
          }
        }
        if (sectionBuckets.unassignedNodes.length > 0) {
          const gKey = 'sec:unassigned';
          const open = !collapsedGroups[gKey];
          out.push({
            kind: 'group',
            key: `g:${gKey}`,
            groupKey: gKey,
            title: t('sec.unassigned'),
            dotColor: 'var(--border-strong)',
            count: sectionBuckets.unassignedNodes.length,
            open,
            hasAction: false,
            height: GROUP_ROW_H,
          });
          if (open) {
            for (const node of sectionBuckets.unassignedNodes) pushTableTree('unassigned', node, 0);
          }
        }
      }

      for (const g of otherGroups) {
        if (!(g.items.length > 0 || (g.showEmpty && !qLower))) continue;
        const open = !collapsedGroups[g.key];
        out.push({
          kind: 'group',
          key: `g:${g.key}`,
          groupKey: g.key,
          title: g.title,
          count: g.items.length,
          open,
          hasAction: Boolean(g.action),
          action: g.action,
          height: GROUP_ROW_H,
        });
        if (open) {
          for (const i of g.items) {
            out.push({
              kind: 'item',
              key: `item:${i.id}`,
              id: i.id,
              label: i.label,
              icon: i.icon,
              hint: i.hint,
              height: TABLE_ROW_H,
            });
          }
        }
      }

      if (
        qLower &&
        (activeGrouping === 'schema' ? filteredTables.length === 0 : !hasSectionMatch) &&
        otherGroups.every((g) => !g.items.length)
      ) {
        out.push({ kind: 'noMatch', key: 'noMatch', text: t('ws.noMatch'), height: NO_MATCH_ROW_H });
      }
      return out;
    }, [
      activeGrouping,
      filteredTables,
      sectionBuckets,
      otherGroups,
      expanded,
      collapsedGroups,
      focusedTableId,
      qLower,
      hasSectionMatch,
      t,
    ]);

    const { offsets, totalHeight } = useMemo(() => {
      const off = new Array<number>(rows.length + 1);
      off[0] = 0;
      for (let i = 0; i < rows.length; i++) off[i + 1] = off[i]! + rows[i]!.height;
      return { offsets: off, totalHeight: off[rows.length]! };
    }, [rows]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const viewportHRef = useRef(800);
    const scrollTopRef = useRef(0);
    const prevViewKeyRef = useRef<string | null>(null);
    const [viewportHeight, setViewportHeight] = useState(800);
    const viewKey = `${activeGrouping}\0${qLower}`;
    const [windowRange, setWindowRange] = useState(() => ({
      viewKey,
      ...calcVisibleWindow(0, 800, offsets),
    }));
    const offsetsRef = useRef(offsets);
    const viewKeyRef = useRef(viewKey);

    const selectGrouping = useCallback(
      (g: SidebarGrouping) => {
        if (g === activeGrouping) return;
        scrollTopRef.current = 0;
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
        setWindowRange((prev) => (prev.viewKey === '' ? prev : { viewKey: '', start: 0, end: 0 }));
        if (grouping === undefined) setLocalGrouping(g);
        onChangeGrouping?.(g);
      },
      [activeGrouping, grouping, onChangeGrouping],
    );

    useLayoutEffect(() => {
      offsetsRef.current = offsets;
      viewKeyRef.current = viewKey;
      if (prevViewKeyRef.current !== viewKey) {
        prevViewKeyRef.current = viewKey;
        scrollTopRef.current = 0;
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
        return;
      }
      const next = calcVisibleWindow(scrollTopRef.current, viewportHRef.current, offsets);
      setWindowRange((prev) =>
        prev.viewKey !== viewKey || (prev.start === next.start && prev.end === next.end)
          ? prev
          : { viewKey, ...next },
      );
    }, [offsets, viewKey]);

    useEffect(() => {
      const el = scrollRef.current;
      if (!el || typeof ResizeObserver === 'undefined') return;
      const initialH = el.clientHeight || 800;
      viewportHRef.current = initialH;
      setViewportHeight((prev) => (Math.abs(prev - initialH) < 4 ? prev : initialH));
      const obs = new ResizeObserver((entries) => {
        const h = entries[0]?.contentRect.height ?? el.clientHeight;
        if (!h || Math.abs(h - viewportHRef.current) < 4) return;
        viewportHRef.current = h;
        setViewportHeight(h);
        const curViewKey = viewKeyRef.current;
        const next = calcVisibleWindow(scrollTopRef.current, h, offsetsRef.current);
        setWindowRange((prev) =>
          prev.viewKey === curViewKey && prev.start === next.start && prev.end === next.end
            ? prev
            : { viewKey: curViewKey, ...next },
        );
      });
      obs.observe(el);
      return () => obs.disconnect();
    }, []);

    const onScroll = useCallback(() => {
      const el = scrollRef.current;
      if (!el || rows.length <= VIRTUAL_THRESHOLD) return;
      scrollTopRef.current = el.scrollTop;
      const next = calcVisibleWindow(el.scrollTop, el.clientHeight || viewportHRef.current, offsets);
      setWindowRange((prev) =>
        prev.viewKey === viewKey && prev.start === next.start && prev.end === next.end
          ? prev
          : { viewKey, ...next },
      );
    }, [offsets, rows.length, viewKey]);

    const isVirtual = rows.length > VIRTUAL_THRESHOLD;
    const viewKeyChanged = windowRange.viewKey !== viewKey;
    const { start, end } = isVirtual
      ? viewKeyChanged
        ? calcVisibleWindow(0, viewportHeight, offsets)
        : {
            start: Math.max(0, Math.min(windowRange.start, rows.length)),
            end: Math.min(rows.length, Math.max(windowRange.start, windowRange.end)),
          }
      : { start: 0, end: rows.length };

    const paddingTop = isVirtual ? offsets[start]! : 0;
    const paddingBottom = isVirtual ? Math.max(0, totalHeight - offsets[end]!) : 0;
    const visibleRows = isVirtual ? rows.slice(start, end) : rows;
    const activeTabId = `${tabBase}-${activeGrouping}`;

    return (
      <nav aria-label={t('ws.objects')} className="flex h-full flex-col">
        {onChangeGrouping && (
          <div className="px-2.5 pt-2">
            <div
              role="tablist"
              {...({ focusgroup: 'tablist nomemory' } as object)}
              aria-label={t('sec.sidebarView')}
              className="seg grid w-full grid-cols-2"
            >
              {(['schema', 'section'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  role="tab"
                  id={`${tabBase}-${g}`}
                  aria-selected={activeGrouping === g}
                  {...(activeGrouping === g ? { focusgroupstart: '' } : {})}
                  onFocus={() => selectGrouping(g)}
                  onClick={() => selectGrouping(g)}
                  className="justify-center px-1.5 text-xs"
                >
                  {t(g === 'schema' ? 'sec.bySchema' : 'sec.bySection')}
                </button>
              ))}
            </div>
          </div>
        )}

        <label
          className={cx(
            'mx-2.5 mb-2 flex h-[var(--ctl-h)] items-center gap-1.5 rounded-sm border border-border-strong bg-surface px-2 text-text-3 focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--primary-ring)]',
            onChangeGrouping ? 'mt-2' : 'mt-2.5',
          )}
        >
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => {
              scrollTopRef.current = 0;
              if (scrollRef.current) scrollRef.current.scrollTop = 0;
              setWindowRange((prev) => (prev.viewKey === '' ? prev : { viewKey: '', start: 0, end: 0 }));
              setQ(e.target.value);
            }}
            placeholder={t('ws.search')}
            aria-label={t('ws.search')}
            className="min-w-0 flex-1 border-0 bg-transparent text-base text-text outline-0"
          />
        </label>

        {activeGrouping === 'section' && onOpenSectionManager && (
          <div className="flex flex-wrap gap-1 px-2.5 pb-2">
            <button
              type="button"
              className="btn sm px-2 text-xs"
              disabled={readOnly}
              onClick={() => onOpenSectionManager('manage')}
            >
              <Plus size={12} aria-hidden="true" />
              {t('sec.newSection')}
            </button>
            <button
              type="button"
              className="btn sm px-2 text-xs"
              disabled={readOnly}
              onClick={() => onOpenSectionManager('suggest')}
            >
              <Sparkles size={12} aria-hidden="true" />
              {t('sec.suggestShort')}
            </button>
            <button
              type="button"
              className="btn sm px-2 text-xs"
              onClick={() => onOpenSectionManager('manage')}
            >
              <Settings2 size={12} aria-hidden="true" />
              {t('sec.manage')}
            </button>
          </div>
        )}

        <div
          ref={scrollRef}
          onScroll={onScroll}
          role={onChangeGrouping ? 'tabpanel' : undefined}
          aria-labelledby={onChangeGrouping ? activeTabId : undefined}
          className="min-h-0 flex-1 overflow-auto"
        >
          <ul
            className="list-none px-1.5 pb-3"
            style={
              isVirtual
                ? { paddingTop: `${paddingTop}px`, paddingBottom: `${paddingBottom + 12}px` }
                : undefined
            }
          >
            {visibleRows.map((row) => {
              switch (row.kind) {
                case 'group':
                  return (
                    <GroupRow
                      key={row.key}
                      groupKey={row.groupKey}
                      title={row.title}
                      dotColor={row.dotColor}
                      count={row.count}
                      open={row.open}
                      action={row.action}
                      onToggle={toggleGroupOpen}
                    />
                  );
                case 'table':
                  return (
                    <TableRow
                      key={row.key}
                      node={row.node}
                      depth={row.depth}
                      tabBase={tabBase}
                      isOpen={row.isOpen}
                      isFocused={row.isFocused}
                      selectedProp={selected}
                      selectedStore={selectedStore}
                      onSelect={onSelect}
                      onToggleExpand={toggleNodeExpand}
                      onFocusTable={onFocusTable}
                      onExitFocus={onExitFocus}
                    />
                  );
                case 'empty':
                  return (
                    <li key={row.key} className="px-5 py-1 text-xs text-text-3">
                      {row.text}
                    </li>
                  );
                case 'item':
                  return (
                    <ItemRow
                      key={row.key}
                      id={row.id}
                      label={row.label}
                      icon={row.icon}
                      hint={row.hint}
                      selectedProp={selected}
                      selectedStore={selectedStore}
                      onSelect={onSelect}
                    />
                  );
                case 'noMatch':
                  return (
                    <li key={row.key} className="px-2 py-4 text-center text-sm text-text-3">
                      {row.text}
                    </li>
                  );
              }
            })}
          </ul>
        </div>
      </nav>
    );
  },
);
