// 左侧对象树：搜索 + 表（分区父表支持展开查看子分区）、枚举、序列、其他（不透明）对象，可折叠（DESIGN.md：Layout）。
import { all, type Model, partitionsOf, resolvePartitionBy, type Table } from '@dowel/core';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  FileCode,
  Hash,
  Layers,
  List,
  Plus,
  Search,
  SquareFunction,
  Table2,
  Zap,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { defaultSchemaOf, dialectUiSpec } from '../dialects.ts';
import { IconButton } from './ui.tsx';

const OPAQUE_ICON: Record<string, typeof Eye> = {
  view: Eye,
  materializedView: Eye,
  function: SquareFunction,
  procedure: SquareFunction,
  aggregate: SquareFunction,
  trigger: Zap,
};

const Item = ({
  label,
  icon,
  active,
  onClick,
  hint,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
  hint?: string;
}) => (
  <li>
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className="flex h-[var(--row-h)] w-full items-center gap-2 rounded-sm pr-2 pl-[22px] text-left font-mono text-sm text-text-2 transition-colors hover:bg-surface-hover aria-[current]:bg-primary-soft aria-[current]:font-medium aria-[current]:text-primary-text [&>svg]:text-text-3 aria-[current]:[&>svg]:text-primary-text"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 font-sans text-xs text-text-3">{hint}</span>}
    </button>
  </li>
);

const Group = ({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: ReactNode;
  children: ReactNode;
}) => {
  const [open, setOpen] = useState(true);
  return (
    <li className="mb-1.5">
      <div className="flex h-[26px] items-center gap-0.5 pr-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-sm px-1.5 text-xs font-semibold text-text-3 hover:text-text-2"
        >
          {open ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          {title}
          <span className="count ml-auto">{count}</span>
        </button>
        {action}
      </div>
      {open && <ul className="list-none p-0">{children}</ul>}
    </li>
  );
};

export const Sidebar = ({
  model,
  selected,
  onSelect,
  onAddSequence,
}: {
  model: Model;
  selected: string | null;
  onSelect: (id: string) => void;
  onAddSequence?: () => void;
}) => {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const defSchema = defaultSchemaOf(model);
  const uiSpec = dialectUiSpec(model.dialect);
  const schemaName = (id: string) => model.objects[id]?.name ?? '';
  const qname = (o: { parent: string; name: string }) =>
    schemaName(o.parent) === defSchema ? o.name : `${schemaName(o.parent)}.${o.name}`;
  const byName = <T extends { name: string }>(xs: T[]) =>
    [...xs].sort((a, b) => a.name.localeCompare(b.name));
  const match = (s: string) => !q || s.toLowerCase().includes(q.trim().toLowerCase());
  const strategyLabel = (tb: Table): string | null => {
    if (!tb.partitionBy) return null;
    const spec = resolvePartitionBy(model, tb);
    if (spec) return spec.strategy.toUpperCase();
    return typeof tb.partitionBy === 'string'
      ? (tb.partitionBy.trim().split(/\s+/)[0]?.toUpperCase() ?? null)
      : null;
  };
  interface TableNode {
    table: Table;
    label: string;
    strat: string | null;
    totalChildren: number;
    children: TableNode[];
    hasSelfMatch: boolean;
    forceExpand: boolean;
  }
  const buildTableNode = (tb: Table, ancestorMatched: boolean, seen: Set<string>): TableNode | null => {
    if (seen.has(tb.id)) return null;
    seen.add(tb.id);
    const label = qname(tb);
    const selfMatched = match(label);
    const rawChildren = byName(partitionsOf(model, tb.id));
    const visibleChildren = rawChildren
      .map((ch) => buildTableNode(ch, ancestorMatched || selfMatched, seen))
      .filter((x): x is TableNode => x !== null);
    if (!ancestorMatched && !selfMatched && visibleChildren.length === 0) return null;
    const childHasSelfMatch = visibleChildren.some((ch) => ch.hasSelfMatch);
    return {
      table: tb,
      label,
      strat: strategyLabel(tb),
      totalChildren: rawChildren.length,
      children: visibleChildren,
      hasSelfMatch: (!!q && selfMatched) || childHasSelfMatch,
      forceExpand: !!q && childHasSelfMatch,
    };
  };
  const filteredTables = byName(all(model, 'table').filter((x) => !x.partitionOf))
    .map((x) => buildTableNode(x, false, new Set()))
    .filter((x): x is TableNode => x !== null);
  const renderTableNode = (node: TableNode, depth: number): ReactNode => {
    const { table, label, strat, totalChildren, children, forceExpand } = node;
    if (depth === 0 && !strat && totalChildren === 0) {
      return (
        <Item
          key={table.id}
          label={label}
          icon={<Table2 size={16} aria-hidden="true" />}
          active={table.id === selected}
          onClick={() => onSelect(table.id)}
        />
      );
    }
    const isOpen = expanded[table.id] ?? forceExpand;
    const hasChildren = children.length > 0;
    const isChild = depth > 0;
    const indentPx = depth * 14;
    return (
      <li key={table.id}>
        <div
          className={isChild ? 'flex h-[26px] items-center' : 'flex h-[var(--row-h)] items-center'}
          style={indentPx ? { paddingLeft: `${indentPx}px` } : undefined}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={isOpen}
              aria-label={t('part.togglePartitions', { name: table.name })}
              onClick={() => setExpanded((prev) => ({ ...prev, [table.id]: !isOpen }))}
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
            aria-current={table.id === selected ? 'true' : undefined}
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
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {strat && (
              <span className="shrink-0 font-mono text-[11px] text-text-3">
                {strat} · {totalChildren}
              </span>
            )}
          </button>
        </div>
        {hasChildren && isOpen && (
          <ul className="list-none p-0">{children.map((ch) => renderTableNode(ch, depth + 1))}</ul>
        )}
      </li>
    );
  };
  const otherGroups: {
    title: string;
    showEmpty?: boolean;
    action?: ReactNode;
    items: { id: string; label: string; icon: ReactNode; hint?: string }[];
  }[] = [
    ...(uiSpec.enums
      ? [
          {
            title: t('ws.enums'),
            items: byName(all(model, 'enum')).map((x) => ({
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
            title: t('ws.sequences'),
            showEmpty: true,
            action: onAddSequence ? (
              <IconButton label={t('ws.addSequence')} size="sm" onClick={onAddSequence}>
                <Plus size={13} aria-hidden="true" />
              </IconButton>
            ) : undefined,
            items: byName(all(model, 'sequence')).map((x) => ({
              id: x.id,
              label: qname(x),
              icon: <Hash size={16} aria-hidden="true" />,
            })),
          },
        ]
      : []),
    {
      title: t('ws.others'),
      items: byName(all(model, 'opaque')).map((x) => {
        const Icon = OPAQUE_ICON[x.objType] ?? FileCode;
        return { id: x.id, label: x.name, hint: x.objType, icon: <Icon size={16} aria-hidden="true" /> };
      }),
    },
  ].map((g) => ({ ...g, items: g.items.filter((i) => match(i.label)) }));

  return (
    <nav aria-label={t('ws.objects')} className="flex h-full flex-col">
      <label className="m-2.5 flex h-[var(--ctl-h)] items-center gap-1.5 rounded-sm border border-border-strong bg-surface px-2 text-text-3 focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--primary-ring)]">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('ws.search')}
          aria-label={t('ws.search')}
          className="min-w-0 flex-1 border-0 bg-transparent text-base text-text outline-0"
        />
      </label>
      <ul className="min-h-0 flex-1 list-none overflow-auto px-1.5 pb-3">
        {filteredTables.length > 0 && (
          <Group title={t('ws.tables')} count={filteredTables.length}>
            {filteredTables.map((node) => renderTableNode(node, 0))}
          </Group>
        )}
        {otherGroups.map(
          (g) =>
            (g.items.length > 0 || (g.showEmpty && !q)) && (
              <Group key={g.title} title={g.title} count={g.items.length} action={g.action}>
                {g.items.map((i) => (
                  <Item
                    key={i.id}
                    label={i.label}
                    icon={i.icon}
                    hint={i.hint}
                    active={i.id === selected}
                    onClick={() => onSelect(i.id)}
                  />
                ))}
              </Group>
            ),
        )}
        {q && filteredTables.length === 0 && otherGroups.every((g) => !g.items.length) && (
          <li className="px-2 py-4 text-center text-sm text-text-3">{t('ws.noMatch')}</li>
        )}
      </ul>
    </nav>
  );
};
