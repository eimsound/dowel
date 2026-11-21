// 属性面板（DESIGN.md：属性面板）：编辑选中的表、枚举、序列；不透明对象只读显示 DDL。
// 输入框是“草稿”：获得焦点时记下所依据对象的版本，保存时一并提交——期间别人改过这些对象，保存会被拒绝（04-ir-design.md 2.3）。
import type { MigrationResult, VersionInfo } from '@dowel/api';
import {
  all,
  COMMON_TYPES,
  type Column,
  childrenOf,
  columnsOf,
  effectiveColumnsOf,
  type FkAction,
  formatPartitionBound,
  formatPartitionBy,
  type Model,
  newId,
  normalizeType,
  parsePartitionBound,
  partitionDescendants,
  partitionKeyColumns,
  type PartitionKey,
  type PartitionSpec,
  type PartitionStrategy,
  partitionsOf,
  resolvePartitionBy,
  type Table,
  validatePartitionBound,
} from '@dowel/core';
import type { Versions } from '@dowel/sync';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Eye,
  FileCode,
  Fingerprint,
  Hash,
  KeyRound,
  Layers,
  Link2,
  List,
  ListTree,
  MousePointerClick,
  Pencil,
  Plus,
  Table2,
  Trash2,
  Unlink,
} from 'lucide-react';
import { type ReactNode, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import { useProject } from '../project.tsx';
import type { Workspace } from '../workspace.ts';
import { shortType, typeLabel } from './Canvas.tsx';
import { Modal } from './Modal.tsx';
import { Banner, cx, Empty, IconButton, Menu, Sql } from './ui.tsx';

type Ctx = { ws: Workspace; model: Model; readOnly: boolean };

/** 失焦或回车时提交，Esc 放弃 */
const Field = ({
  value,
  onCommit,
  label,
  basisIds,
  ws,
  list,
  placeholder,
  mono,
  className,
  autoFocus,
  disabled,
}: {
  value: string;
  onCommit: (v: string, basis: Versions) => void;
  label: string;
  basisIds: string[];
  ws: Workspace;
  list?: string;
  placeholder?: string;
  mono?: boolean;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  const basis = useRef<Versions>({});
  const cancelled = useRef(false);
  return (
    <input
      aria-label={label}
      value={draft ?? value}
      list={list}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={disabled}
      spellCheck={false}
      className={cx('input', mono && 'font-mono', className)}
      onFocus={() => {
        cancelled.current = false;
        setDraft(value);
        basis.current = ws.client.basisOf(basisIds);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        // 输入法组字中按回车是确认候选词，不是提交（Safari / 部分安卓只给 keyCode 229）
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        if (!cancelled.current && draft !== null && draft !== value) onCommit(draft, basis.current);
        setDraft(null);
      }}
    />
  );
};

/** 带可见标签的字段（标签只给视觉用户，输入框自己的 aria-label 更具体） */
const Labeled = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="field">
    <span className="label" aria-hidden="true">
      {label}
    </span>
    {children}
  </div>
);

const Section = ({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section className="space-y-1.5 border-t border-border pt-3">
    <h3 className="section-title">
      {title}
      {count !== undefined && <span className="count">{count}</span>}
      <span className="ml-auto flex items-center gap-1">{action}</span>
    </h3>
    {children}
  </section>
);

/** 约束、索引列表的一行：图标 + 名字 + 定义 + 删除 */
const Row = ({
  icon,
  name,
  children,
  onDelete,
  deleteLabel,
}: {
  icon: ReactNode;
  name: string;
  children: ReactNode;
  onDelete?: () => void;
  deleteLabel: string;
}) => (
  <li className="group grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2 rounded-sm px-1.5 py-1 hover:bg-surface-hover">
    <span className="mt-0.5 text-text-3">{icon}</span>
    <div className="min-w-0">
      <div className="truncate font-mono text-sm">{name}</div>
      <div className="font-mono text-xs text-text-3">{children}</div>
    </div>
    {onDelete && (
      <IconButton
        label={deleteLabel}
        size="sm"
        className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={onDelete}
      >
        <Trash2 size={14} aria-hidden="true" />
      </IconButton>
    )}
  </li>
);

const ColumnPicker = ({
  columns,
  value,
  onChange,
  label,
}: {
  columns: Column[];
  value: string[];
  onChange: (ids: string[]) => void;
  label: string;
}) => (
  <fieldset className="checks border-0 p-0">
    <legend className="label mb-1.5 p-0">{label}</legend>
    {columns.map((c) => (
      <label key={c.id} className="font-mono">
        <input
          type="checkbox"
          checked={value.includes(c.id)}
          onChange={(e) => onChange(e.target.checked ? [...value, c.id] : value.filter((x) => x !== c.id))}
        />
        {c.name}
      </label>
    ))}
  </fieldset>
);

/** 面板里的新增表单：标题 + 内容 + 取消 / 确认 */
const AddForm = ({
  title,
  children,
  onCancel,
  submit,
}: {
  title: string;
  children: ReactNode;
  onCancel: () => void;
  submit?: ReactNode;
}) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-2.5 rounded-sm border border-border bg-surface-2 p-2.5">
      <div className="text-xs font-semibold text-text-2">{title}</div>
      {children}
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          className="btn ghost"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCancel}
        >
          {t('dlg.cancel')}
        </button>
        {submit}
      </div>
    </div>
  );
};

/** 解析类型输入：枚举名（可带 schema、可带 []）→ typeRef；否则规范化成 PG 的写法 */
const parseType = (m: Model, text: string): { type: string; typeRef: string | null } => {
  const arr = /(\[\])*$/.exec(text.trim())![0];
  const base = text.trim().slice(0, text.trim().length - arr.length);
  const e = all(m, 'enum').find((x) => x.name === base || `${m.objects[x.parent]?.name}.${x.name}` === base);
  return e ? { type: arr, typeRef: e.id } : { type: normalizeType(text), typeRef: null };
};

const FK_ACTIONS: FkAction[] = ['noAction', 'restrict', 'cascade', 'setNull', 'setDefault'];

// ───── 分区边界动态表单状态 ─────

interface BoundDraft {
  isDefault: boolean;
  from: string[];
  to: string[];
  list: string;
  modulus: string;
  remainder: string;
}

const initBoundDraft = (spec: PartitionSpec, existing?: string): BoundDraft => {
  const k = Math.max(1, spec.keys.length);
  const base: BoundDraft = {
    isDefault: false,
    from: Array.from({ length: k }, () => ''),
    to: Array.from({ length: k }, () => ''),
    list: '',
    modulus: '4',
    remainder: '0',
  };
  if (!existing) return base;
  const parsed = parsePartitionBound(existing);
  if (!parsed) return base;
  if (parsed.kind === 'default') return { ...base, isDefault: true };
  if (parsed.kind === 'range') {
    return {
      ...base,
      from: Array.from({ length: k }, (_, i) => parsed.from[i] ?? ''),
      to: Array.from({ length: k }, (_, i) => parsed.to[i] ?? ''),
    };
  }
  if (parsed.kind === 'list') return { ...base, list: parsed.values.join(', ') };
  return { ...base, modulus: String(parsed.modulus), remainder: String(parsed.remainder) };
};

const buildBoundString = (spec: PartitionSpec, draft: BoundDraft): string => {
  if (draft.isDefault && spec.strategy !== 'hash') return formatPartitionBound({ kind: 'default' });
  if (spec.strategy === 'range') {
    return formatPartitionBound({
      kind: 'range',
      from: draft.from.map((s) => s.trim()),
      to: draft.to.map((s) => s.trim()),
    });
  }
  if (spec.strategy === 'list') {
    const raw = draft.list.trim();
    return raw ? `FOR VALUES IN (${raw})` : '';
  }
  const modulus = Number.parseInt(draft.modulus, 10);
  const remainder = Number.parseInt(draft.remainder, 10);
  if (!Number.isInteger(modulus) || !Number.isInteger(remainder)) return '';
  return formatPartitionBound({ kind: 'hash', modulus, remainder });
};

const BoundInputs = ({
  spec,
  draft,
  onChange,
  hasDefault,
  isSelfDefault,
}: {
  spec: PartitionSpec;
  draft: BoundDraft;
  onChange: (next: BoundDraft) => void;
  hasDefault: boolean;
  isSelfDefault?: boolean;
}) => {
  const { t } = useTranslation();
  const defaultBlocked = hasDefault && !isSelfDefault;
  const keyCount = Math.max(1, spec.keys.length);

  return (
    <div className="space-y-2">
      {spec.strategy !== 'hash' && (
        <div className="space-y-1">
          <label className="check text-sm">
            <input
              type="checkbox"
              checked={draft.isDefault}
              disabled={defaultBlocked}
              onChange={(e) => onChange({ ...draft, isDefault: e.target.checked })}
            />
            {t('part.defaultPartition')}
          </label>
          {defaultBlocked && <p className="hint">{t('part.defaultExists')}</p>}
        </div>
      )}

      {!draft.isDefault && spec.strategy === 'range' && (
        <div className="space-y-2">
          {Array.from({ length: keyCount }, (_, idx) => {
            const suffix = keyCount > 1 ? ` #${idx + 1}` : '';
            const fromVal = draft.from[idx] ?? '';
            const toVal = draft.to[idx] ?? '';
            const setFrom = (v: string) => {
              const next = [...draft.from];
              next[idx] = v;
              onChange({ ...draft, from: next });
            };
            const setTo = (v: string) => {
              const next = [...draft.to];
              next[idx] = v;
              onChange({ ...draft, to: next });
            };
            return (
              <div key={idx} className="space-y-1.5">
                <div className="field">
                  <div className="flex items-center justify-between">
                    <span className="label">{`${t('part.rangeFrom')}${suffix}`}</span>
                    <button
                      type="button"
                      className="btn ghost sm font-mono text-[11px]"
                      onClick={() => setFrom('MINVALUE')}
                    >
                      MINVALUE
                    </button>
                  </div>
                  <input
                    aria-label={`${t('part.rangeFrom')}${suffix}`}
                    className="input font-mono"
                    spellCheck={false}
                    placeholder="'2025-01-01'"
                    value={fromVal}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </div>
                <div className="field">
                  <div className="flex items-center justify-between">
                    <span className="label">{`${t('part.rangeTo')}${suffix}`}</span>
                    <button
                      type="button"
                      className="btn ghost sm font-mono text-[11px]"
                      onClick={() => setTo('MAXVALUE')}
                    >
                      MAXVALUE
                    </button>
                  </div>
                  <input
                    aria-label={`${t('part.rangeTo')}${suffix}`}
                    className="input font-mono"
                    spellCheck={false}
                    placeholder="'2026-01-01'"
                    value={toVal}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </div>
              </div>
            );
          })}
          <p className="hint">{t('part.rangeHint')}</p>
        </div>
      )}

      {!draft.isDefault && spec.strategy === 'list' && (
        <div className="space-y-1">
          <label className="field">
            <span className="label">{t('part.listValues')}</span>
            <input
              aria-label={t('part.listValues')}
              className="input font-mono"
              spellCheck={false}
              placeholder={t('part.listPlaceholder')}
              value={draft.list}
              onChange={(e) => onChange({ ...draft, list: e.target.value })}
            />
          </label>
          <p className="hint">{t('part.listHint')}</p>
        </div>
      )}

      {spec.strategy === 'hash' && (
        <div className="grid grid-cols-2 gap-2">
          <label className="field">
            <span className="label">{t('part.hashModulus')}</span>
            <input
              type="number"
              min={1}
              step={1}
              aria-label={t('part.hashModulus')}
              className="input font-mono"
              value={draft.modulus}
              onChange={(e) => onChange({ ...draft, modulus: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="label">{t('part.hashRemainder')}</span>
            <input
              type="number"
              min={0}
              step={1}
              aria-label={t('part.hashRemainder')}
              className="input font-mono"
              value={draft.remainder}
              onChange={(e) => onChange({ ...draft, remainder: e.target.value })}
            />
          </label>
        </div>
      )}
    </div>
  );
};

/** 筛选列定义与分区父表一致、可挂载为子分区的普通表（与 edit.ts attachPartition 对齐） */
const compatiblePlainTables = (model: Model, parent: Table): Table[] => {
  const rootCols = effectiveColumnsOf(model, parent.id);
  const referencedByExternalFk = new Set(
    all(model, 'foreignKey')
      .filter((fk) => fk.refTable !== fk.parent)
      .map((fk) => fk.refTable),
  );
  const ownedColIds = new Set(
    all(model, 'sequence')
      .map((s) => s.ownedBy)
      .filter((x): x is string => x !== null),
  );
  return all(model, 'table').filter((cand) => {
    if (cand.id === parent.id || cand.partitionBy !== null || cand.partitionOf !== null) return false;
    if (referencedByExternalFk.has(cand.id)) return false;
    const cols = columnsOf(model, cand.id);
    if (cols.length !== rootCols.length) return false;
    if (cols.some((c) => c.identity !== null || ownedColIds.has(c.id))) return false;
    return rootCols.every((rc) => {
      const cc = cols.find((x) => x.name === rc.name);
      if (!cc) return false;
      return (
        cc.type === rc.type &&
        cc.typeRef === rc.typeRef &&
        cc.collation === rc.collation &&
        cc.notNull === rc.notNull &&
        JSON.stringify(cc.generated) === JSON.stringify(rc.generated) &&
        JSON.stringify(cc.default) === JSON.stringify(rc.default)
      );
    });
  });
};

interface KeyDraft {
  mode: 'column' | 'expr';
  column: string;
  expr: string;
  collation: string;
  opclass: string;
}

const TableInspector = ({
  table,
  ws,
  model,
  readOnly,
  onSelect,
}: Ctx & { table: Table; onSelect: (id: string | null) => void }) => {
  const { t } = useTranslation();
  const { pid } = useProject();
  const versions = useQuery({
    queryKey: ['versions', pid],
    queryFn: () => api<VersionInfo[]>('GET', `/api/projects/${pid}/versions`),
  });
  const latestId = versions.data?.[0]?.id;
  const latestTables = useQuery({
    queryKey: ['version-tables', pid, latestId],
    queryFn: async () => {
      const { up } = await api<MigrationResult>(
        'GET',
        `/api/projects/${pid}/migration?from=empty&to=${encodeURIComponent(latestId!)}`,
      );
      return new Set(up.filter((s) => s.kind === 'createTable').map((s) => s.target));
    },
    enabled: !!latestId,
    staleTime: Infinity,
  });
  const isPublished = !!latestTables.data?.has(table.id);

  const isChild = table.partitionOf !== null;
  const cols = isChild ? effectiveColumnsOf(model, table.id) : columnsOf(model, table.id);
  const pk = childrenOf(model, table.id, 'primaryKey')[0];
  const checks = childrenOf(model, table.id, 'check');
  const uniques = childrenOf(model, table.id, 'unique');
  const fks = childrenOf(model, table.id, 'foreignKey');
  const indexes = childrenOf(model, table.id, 'index');
  const tableIds = [table.id, ...cols.map((c) => c.id)];
  const name = (id: string) => model.objects[id]?.name ?? '?';
  const locked = readOnly;
  const fkCols = new Set(fks.flatMap((f) => f.columns));

  const partKeyCols = useMemo(() => {
    const ids = new Set<string>();
    const tablesToScan = isChild ? [table] : [table, ...partitionDescendants(model, table.id)];
    for (const tb of tablesToScan) {
      if (tb.partitionBy) {
        for (const id of partitionKeyColumns(model, tb).all) ids.add(id);
      }
    }
    return ids;
  }, [isChild, model, table]);

  const spec = table.partitionBy ? resolvePartitionBy(model, table) : null;
  const children = partitionsOf(model, table.id);
  const parentTable = table.partitionOf
    ? (model.objects[table.partitionOf.parent] as Table | undefined)
    : undefined;
  const parentSpec = parentTable?.partitionBy ? resolvePartitionBy(model, parentTable) : null;
  const hasDefaultChild = children.some((c) => parsePartitionBound(c.partitionOf!.bound)?.kind === 'default');
  const parentHasDefault = parentTable
    ? partitionsOf(model, parentTable.id).some(
        (c) => parsePartitionBound(c.partitionOf!.bound)?.kind === 'default',
      )
    : false;
  const selfIsDefault = !!(
    table.partitionOf && parsePartitionBound(table.partitionOf.bound)?.kind === 'default'
  );

  const [openCol, setOpenCol] = useState<string | null>(null);
  const [focusNew, setFocusNew] = useState<string | null>(null);
  const [adding, setAdding] = useState<'check' | 'unique' | 'fk' | 'index' | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [indexUnique, setIndexUnique] = useState(false);
  const emptyFk = { col: '', ref: '', refCol: '', onDelete: 'noAction' as FkAction };
  const [fk, setFk] = useState(emptyFk);
  const typesId = useId();

  // 分区配置与子分区操作状态
  const [editingStrategy, setEditingStrategy] = useState(false);
  const [draftStrategy, setDraftStrategy] = useState<PartitionStrategy>('range');
  const [draftKeys, setDraftKeys] = useState<KeyDraft[]>([]);
  const [partForm, setPartForm] = useState<'add' | 'attach' | null>(null);
  const [childName, setChildName] = useState('');
  const [attachTableId, setAttachTableId] = useState('');
  const [boundDraft, setBoundDraft] = useState<BoundDraft>(() =>
    initBoundDraft(spec ?? { strategy: 'range', keys: [] }),
  );
  const [editingBoundId, setEditingBoundId] = useState<string | null>(null);
  const [editBoundDraft, setEditBoundDraft] = useState<BoundDraft>(() =>
    initBoundDraft(spec ?? parentSpec ?? { strategy: 'range', keys: [] }),
  );

  // 实时降级为只读时直接派生为关闭，避免 effect 中 setState 级联渲染（pitfalls #30）
  const activeAdding = locked ? null : adding;
  const activeEditingStrategy = !locked && !isPublished && editingStrategy;
  const activePartForm = locked ? null : partForm;
  const activeEditingBoundId = locked ? null : editingBoundId;

  const startAdding = (k: typeof adding) => {
    setAdding(k);
    setPicked([]);
    setIndexUnique(false);
    setFk(emptyFk);
  };
  const setPk = (colId: string, on: boolean) => {
    const next = on ? [...(pk?.columns ?? []), colId] : (pk?.columns ?? []).filter((c) => c !== colId);
    if (pk) ws.act('dropKey', { id: pk.id });
    if (next.length) ws.act('addPrimaryKey', { id: newId(), table: table.id, columns: next });
  };
  // 外键可引用的列：被引用表上单列主键或唯一约束的列
  const refCols = fk.ref
    ? [...childrenOf(model, fk.ref, 'primaryKey'), ...childrenOf(model, fk.ref, 'unique')]
        .filter((k) => k.columns.length === 1)
        .map((k) => k.columns[0]!)
    : [];
  const addColumn = () => {
    let n = cols.length + 1;
    while (cols.some((c) => c.name === `column_${n}`)) n++;
    const id = newId();
    if (ws.act('addColumn', { table: table.id, column: { id, name: `column_${n}`, type: 'text' } })) {
      setOpenCol(id);
      setFocusNew(id);
    }
  };
  const defaultText = (c: Column) =>
    c.default ? ('expr' in c.default ? c.default.expr : `nextval(${name(c.default.nextval)})`) : '';

  const openStrategyEditor = () => {
    const curSpec = spec;
    setDraftStrategy(curSpec?.strategy ?? 'range');
    if (curSpec?.keys.length) {
      setDraftKeys(
        curSpec.keys.map((k) => ({
          mode: k.column ? 'column' : 'expr',
          column: k.column ?? cols[0]?.id ?? '',
          expr: k.expr ?? '',
          collation: k.collation ?? '',
          opclass: k.opclass ?? '',
        })),
      );
    } else {
      setDraftKeys([{ mode: 'column', column: cols[0]?.id ?? '', expr: '', collation: '', opclass: '' }]);
    }
    setEditingStrategy(true);
  };

  const commitStrategy = () => {
    const keys: PartitionKey[] = draftKeys.map((k) =>
      k.mode === 'column'
        ? {
            column: k.column,
            expr: null,
            collation: k.collation.trim() || null,
            opclass: k.opclass.trim() || null,
          }
        : {
            column: null,
            expr: k.expr.trim(),
            collation: k.collation.trim() || null,
            opclass: k.opclass.trim() || null,
          },
    );
    const nextSpec: PartitionSpec = { strategy: draftStrategy, keys };
    if (ws.act('setPartitionBy', { id: table.id, partitionBy: nextSpec })) {
      setEditingStrategy(false);
    }
  };

  const strategyValid =
    draftKeys.length > 0 &&
    (draftStrategy !== 'list' || draftKeys.length === 1) &&
    draftKeys.every((k) => (k.mode === 'column' ? !!k.column : !!k.expr.trim()));

  const openAddPartition = () => {
    if (!spec) return;
    let n = children.length + 1;
    while (all(model, 'table').some((x) => x.name === `${table.name}_p${n}`)) n++;
    setChildName(`${table.name}_p${n}`);
    setBoundDraft(initBoundDraft(spec));
    setPartForm('add');
  };

  const openAttachPartition = () => {
    if (!spec) return;
    const cands = compatiblePlainTables(model, table);
    setAttachTableId(cands[0]?.id ?? '');
    setBoundDraft(initBoundDraft(spec));
    setPartForm('attach');
  };

  const openEditBound = (target: Table, activeSpec: PartitionSpec) => {
    setEditBoundDraft(initBoundDraft(activeSpec, target.partitionOf?.bound));
    setEditingBoundId(target.id);
  };

  const attachCandidates = activePartForm === 'attach' ? compatiblePlainTables(model, table) : [];
  const formBoundStr = spec ? buildBoundString(spec, boundDraft) : '';
  const formBoundError =
    spec && formBoundStr ? validatePartitionBound(spec.strategy, formBoundStr, spec.keys.length) : null;

  const activeEditSpec = isChild ? parentSpec : spec;
  const editBoundStr = activeEditSpec ? buildBoundString(activeEditSpec, editBoundDraft) : '';
  const editBoundError =
    activeEditSpec && editBoundStr
      ? validatePartitionBound(activeEditSpec.strategy, editBoundStr, activeEditSpec.keys.length)
      : null;

  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3 border-0 p-0">
      {isChild && parentTable && (
        <div className="flex items-center gap-2 rounded-sm border border-border bg-surface-2 px-2.5 py-2 text-xs">
          <Layers size={14} aria-hidden="true" className="shrink-0 text-text-3" />
          <span className="min-w-0 flex-1 truncate text-text-2">
            {t('part.childOf', { parent: parentTable.name })}
          </span>
          <button
            type="button"
            className="btn ghost sm shrink-0"
            disabled={false}
            onClick={() => onSelect(parentTable.id)}
          >
            {t('part.viewParent')}
          </button>
        </div>
      )}

      <Labeled label={t('insp.tableName')}>
        <Field
          ws={ws}
          label={t('insp.tableName')}
          value={table.name}
          basisIds={[table.id]}
          mono
          onCommit={(v, b) => ws.act('renameTable', { id: table.id, name: v.trim() }, b)}
        />
      </Labeled>
      <Labeled label={t('insp.comment')}>
        <Field
          ws={ws}
          label={t('insp.comment')}
          placeholder={t('insp.commentPlaceholder')}
          value={table.comment ?? ''}
          basisIds={[table.id]}
          onCommit={(v, b) => ws.act('setComment', { id: table.id, comment: v.trim() || null }, b)}
        />
      </Labeled>

      {isChild && table.partitionOf && (
        <Section
          title={t('part.bound')}
          action={
            !locked && (
              <>
                {parentSpec && (
                  <IconButton
                    label={t('part.editBoundLabel', { name: table.name })}
                    size="sm"
                    onClick={() => openEditBound(table, parentSpec)}
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </IconButton>
                )}
                <IconButton
                  label={t('part.detachLabel', { name: table.name })}
                  size="sm"
                  onClick={() => ws.act('detachPartition', { id: table.id })}
                >
                  <Unlink size={14} aria-hidden="true" />
                </IconButton>
              </>
            )
          }
        >
          <div className="rounded-sm border border-border bg-surface px-2.5 py-1.5 font-mono text-xs text-text-2">
            {table.partitionOf.bound}
          </div>
          {table.partitionBy && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="badge">{t('part.subPartitionBadge')}</span>
              <span className="font-mono text-xs text-text-3">{formatPartitionBy(model, table)}</span>
            </div>
          )}
          {activeEditingBoundId === table.id && parentSpec && (
            <AddForm
              title={t('part.editBound')}
              onCancel={() => setEditingBoundId(null)}
              submit={
                <button
                  type="button"
                  className="btn primary"
                  disabled={!editBoundStr || !!editBoundError}
                  onClick={() => {
                    if (ws.act('setPartitionBound', { id: table.id, bound: editBoundStr })) {
                      setEditingBoundId(null);
                    }
                  }}
                >
                  {t('part.saveBound')}
                </button>
              }
            >
              <BoundInputs
                spec={parentSpec}
                draft={editBoundDraft}
                onChange={setEditBoundDraft}
                hasDefault={parentHasDefault}
                isSelfDefault={selfIsDefault}
              />
              {editBoundError && <p className="hint text-danger">{editBoundError}</p>}
            </AddForm>
          )}
        </Section>
      )}

      <Section
        title={t('insp.columns')}
        count={cols.length}
        action={
          !locked &&
          !isChild && (
            <IconButton label={t('insp.addColumn')} size="sm" onClick={addColumn}>
              <Plus size={14} aria-hidden="true" />
            </IconButton>
          )
        }
      >
        {!isChild && (
          <datalist id={typesId}>
            {[...COMMON_TYPES, ...all(model, 'enum').map((e) => e.name)].map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        )}
        <ul className="list-none overflow-hidden rounded-sm border border-border bg-surface p-0">
          {cols.map((c, i) => {
            const open = !isChild && openCol === c.id;
            const isPk = !!pk?.columns.includes(c.id);
            const isPartKey = partKeyCols.has(c.id);
            if (isChild) {
              return (
                <li
                  key={c.id}
                  className="flex h-[var(--row-h)] items-center gap-1.5 border-border px-2.5 text-sm not-first:border-t"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-text-2">{c.name}</span>
                  <span className={cx('truncate font-mono text-xs', c.typeRef ? 'text-enum' : 'text-text-3')}>
                    {shortType(typeLabel(model, c))}
                  </span>
                  <span className="flex w-[52px] justify-end gap-[3px]">
                    {c.notNull && <b className="flag">NN</b>}
                  </span>
                </li>
              );
            }
            return (
              <li key={c.id} className="border-border not-first:border-t">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenCol(open ? null : c.id)}
                  className={cx(
                    'flex h-[var(--row-h)] w-full items-center gap-1.5 pr-2 pl-1.5 text-left text-sm',
                    open ? 'bg-primary-soft' : 'hover:bg-surface-hover',
                  )}
                >
                  {open ? (
                    <ChevronDown size={14} aria-hidden="true" className="text-text-3" />
                  ) : (
                    <ChevronRight size={14} aria-hidden="true" className="text-text-3" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono">{c.name}</span>
                  <span className={cx('truncate font-mono text-xs', c.typeRef ? 'text-enum' : 'text-text-3')}>
                    {shortType(typeLabel(model, c))}
                  </span>
                  <span className="flex min-w-[52px] shrink-0 justify-end gap-[3px]">
                    {isPk && <b className="flag pk">PK</b>}
                    {fkCols.has(c.id) && <b className="flag fk">FK</b>}
                    {isPartKey && <b className="flag">PT</b>}
                    {c.notNull && !isPk && <b className="flag">NN</b>}
                  </span>
                </button>
                {open && (
                  <div className="space-y-2 border-t border-border bg-surface-2 px-2.5 pt-2.5 pb-3">
                    <div className="grid grid-cols-2 gap-2">
                      <Labeled label={t('insp.columnName')}>
                        <Field
                          ws={ws}
                          label={`${t('insp.columnName')} ${c.name}`}
                          value={c.name}
                          basisIds={[c.id, table.id]}
                          mono
                          autoFocus={focusNew === c.id}
                          onCommit={(v, b) => ws.act('renameColumn', { id: c.id, name: v.trim() }, b)}
                        />
                      </Labeled>
                      <Labeled label={t('insp.type')}>
                        <Field
                          ws={ws}
                          label={`${t('insp.type')} ${c.name}`}
                          value={typeLabel(model, c)}
                          list={typesId}
                          basisIds={[c.id]}
                          mono
                          disabled={isPartKey}
                          onCommit={(v, b) =>
                            ws.act('setColumnType', { id: c.id, ...parseType(model, v) }, b)
                          }
                        />
                      </Labeled>
                    </div>
                    {isPartKey && <p className="hint">{t('part.keyColLockedHint')}</p>}
                    <Labeled label={t('insp.default')}>
                      <Field
                        ws={ws}
                        label={`${t('insp.default')} ${c.name}`}
                        placeholder={t('insp.none')}
                        value={defaultText(c)}
                        basisIds={[c.id]}
                        mono
                        onCommit={(v, b) =>
                          ws.act('setDefault', { id: c.id, default: v.trim() ? { expr: v.trim() } : null }, b)
                        }
                      />
                    </Labeled>
                    <div className="flex items-center gap-1">
                      <div className="checks flex-1">
                        <label>
                          <input
                            type="checkbox"
                            checked={c.notNull}
                            onChange={(e) => ws.act('setNotNull', { id: c.id, notNull: e.target.checked })}
                          />
                          {t('insp.notNull')}
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={isPk}
                            onChange={(e) => setPk(c.id, e.target.checked)}
                          />
                          {t('insp.pk')}
                        </label>
                      </div>
                      <IconButton
                        label={`${t('insp.moveUp')} ${c.name}`}
                        size="sm"
                        disabled={i === 0}
                        onClick={() => ws.act('moveColumn', { id: c.id, before: cols[i - 1]!.id })}
                      >
                        <ArrowUp size={14} aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        label={`${t('insp.moveDown')} ${c.name}`}
                        size="sm"
                        disabled={i === cols.length - 1}
                        onClick={() => ws.act('moveColumn', { id: c.id, before: cols[i + 2]?.id ?? null })}
                      >
                        <ArrowDown size={14} aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        label={
                          isPartKey
                            ? t('part.keyColDeleteLocked', { name: c.name })
                            : `${t('insp.delete')} ${c.name}`
                        }
                        size="sm"
                        disabled={isPartKey}
                        className="hover:!text-danger"
                        onClick={() => ws.act('dropColumn', { id: c.id })}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </IconButton>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {isChild && <p className="hint">{t('part.inheritedColumns')}</p>}
        {cols.length === 0 && <p className="hint">{t('insp.noColumns')}</p>}
      </Section>

      <Section
        title={t('insp.constraints')}
        count={(pk ? 1 : 0) + fks.length + uniques.length + checks.length}
        action={
          !locked && (
            <Menu
              label={t('insp.addConstraint')}
              trigger={<Plus size={14} aria-hidden="true" />}
              triggerClassName="btn icon ghost sm"
              items={[
                { label: t('insp.check'), onSelect: () => startAdding('check') },
                { label: t('insp.uniqueConstraint'), onSelect: () => startAdding('unique') },
                { label: t('insp.fk'), onSelect: () => startAdding('fk') },
              ]}
            />
          )
        }
      >
        <ul className="list-none space-y-0.5 p-0">
          {pk && (
            <Row
              icon={<KeyRound size={14} aria-hidden="true" className="text-pk" />}
              name={pk.name}
              deleteLabel={`${t('insp.delete')} ${pk.name}`}
              onDelete={locked ? undefined : () => ws.act('dropKey', { id: pk.id })}
            >
              ({pk.columns.map(name).join(', ')})
            </Row>
          )}
          {fks.map((f) => (
            <Row
              key={f.id}
              icon={<Link2 size={14} aria-hidden="true" className="text-fk" />}
              name={f.name}
              deleteLabel={`${t('insp.delete')} ${f.name}`}
              onDelete={locked ? undefined : () => ws.act('dropKey', { id: f.id })}
            >
              {f.columns.map(name).join(', ')} → {name(f.refTable)}.{f.refColumns.map(name).join(', ')}
              {f.onDelete !== 'noAction' && ` · ON DELETE ${f.onDelete}`}
            </Row>
          ))}
          {uniques.map((u) => (
            <Row
              key={u.id}
              icon={<Fingerprint size={14} aria-hidden="true" />}
              name={u.name}
              deleteLabel={`${t('insp.delete')} ${u.name}`}
              onDelete={locked ? undefined : () => ws.act('dropKey', { id: u.id })}
            >
              UNIQUE ({u.columns.map(name).join(', ')})
            </Row>
          ))}
          {checks.map((k) => (
            <Row
              key={k.id}
              icon={<Check size={14} aria-hidden="true" />}
              name={k.name}
              deleteLabel={`${t('insp.delete')} ${k.name}`}
              onDelete={locked ? undefined : () => ws.act('dropKey', { id: k.id })}
            >
              <Field
                ws={ws}
                label={`${t('insp.expr')} ${k.name}`}
                value={k.expr}
                basisIds={[k.id, ...tableIds]}
                mono
                className="inline-edit"
                onCommit={(v, b) => ws.act('setCheckExpr', { id: k.id, expr: v.trim() }, b)}
              />
            </Row>
          ))}
        </ul>
        {!pk && !fks.length && !uniques.length && !checks.length && activeAdding === null && (
          <p className="hint">{t('insp.noConstraints')}</p>
        )}
        {activeAdding === 'check' && (
          <AddForm title={t('insp.addCheck')} onCancel={() => setAdding(null)}>
            <Field
              ws={ws}
              label={t('insp.checkExpr')}
              placeholder="price > 0"
              value=""
              basisIds={tableIds}
              mono
              autoFocus
              onCommit={(v, b) => {
                if (v.trim() && ws.act('addCheck', { id: newId(), table: table.id, expr: v.trim() }, b))
                  setAdding(null);
              }}
            />
            <p className="hint">{t('insp.checkHint')}</p>
          </AddForm>
        )}
        {activeAdding === 'unique' && (
          <AddForm
            title={t('insp.addUnique')}
            onCancel={() => setAdding(null)}
            submit={
              <button
                type="button"
                className="btn primary"
                disabled={!picked.length}
                onClick={() =>
                  ws.act('addUnique', { id: newId(), table: table.id, columns: picked }) && setAdding(null)
                }
              >
                {t('insp.addUnique')}
              </button>
            }
          >
            <ColumnPicker label={t('insp.pickColumns')} columns={cols} value={picked} onChange={setPicked} />
          </AddForm>
        )}
        {activeAdding === 'fk' && (
          <AddForm
            title={t('insp.addFk')}
            onCancel={() => setAdding(null)}
            submit={
              <button
                type="button"
                className="btn primary"
                disabled={!fk.col || !fk.ref || !fk.refCol}
                onClick={() =>
                  ws.act('addForeignKey', {
                    id: newId(),
                    table: table.id,
                    columns: [fk.col],
                    refTable: fk.ref,
                    refColumns: [fk.refCol],
                    onDelete: fk.onDelete,
                  }) && setAdding(null)
                }
              >
                {t('insp.addFk')}
              </button>
            }
          >
            <div className="grid grid-cols-2 gap-2">
              <label className="field">
                <span className="label">{t('insp.fkColumn')}</span>
                <select
                  className="select font-mono"
                  value={fk.col}
                  onChange={(e) => setFk({ ...fk, col: e.target.value })}
                >
                  <option value="">—</option>
                  {cols.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="label">{t('insp.refTable')}</span>
                <select
                  className="select font-mono"
                  value={fk.ref}
                  onChange={(e) => setFk({ ...fk, ref: e.target.value, refCol: '' })}
                >
                  <option value="">—</option>
                  {all(model, 'table')
                    .filter((x) => !x.partitionOf)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span className="label">{t('insp.refColumn')}</span>
                <select
                  className="select font-mono"
                  value={fk.refCol}
                  onChange={(e) => setFk({ ...fk, refCol: e.target.value })}
                >
                  <option value="">—</option>
                  {refCols.map((c) => (
                    <option key={c} value={c}>
                      {name(c)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="label">{t('insp.onDelete')}</span>
                <select
                  className="select font-mono"
                  value={fk.onDelete}
                  onChange={(e) => setFk({ ...fk, onDelete: e.target.value as FkAction })}
                >
                  {FK_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {t(`insp.fkAction.${a}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {fk.ref && !refCols.length && <p className="hint">{t('insp.fkNoKey')}</p>}
          </AddForm>
        )}
      </Section>

      <Section
        title={t('insp.indexes')}
        count={indexes.length}
        action={
          !locked && (
            <IconButton label={t('insp.addIndex')} size="sm" onClick={() => startAdding('index')}>
              <Plus size={14} aria-hidden="true" />
            </IconButton>
          )
        }
      >
        <ul className="list-none space-y-0.5 p-0">
          {indexes.map((x) => (
            <Row
              key={x.id}
              icon={<ListTree size={14} aria-hidden="true" />}
              name={x.name}
              deleteLabel={`${t('insp.delete')} ${x.name}`}
              onDelete={locked ? undefined : () => ws.act('dropKey', { id: x.id })}
            >
              {x.unique && 'UNIQUE '}
              {x.method} ({x.elements.map((e) => (e.column ? name(e.column) : e.expr)).join(', ')})
            </Row>
          ))}
        </ul>
        {!indexes.length && activeAdding !== 'index' && <p className="hint">{t('insp.noIndexes')}</p>}
        {activeAdding === 'index' && (
          <AddForm
            title={t('insp.addIndex')}
            onCancel={() => setAdding(null)}
            submit={
              <button
                type="button"
                className="btn primary"
                disabled={!picked.length}
                onClick={() =>
                  ws.act('addIndex', {
                    id: newId(),
                    table: table.id,
                    elements: picked.map((column) => ({ column })),
                    unique: indexUnique,
                  }) && setAdding(null)
                }
              >
                {t('insp.addIndex')}
              </button>
            }
          >
            <ColumnPicker label={t('insp.pickColumns')} columns={cols} value={picked} onChange={setPicked} />
            <label className="check text-sm">
              <input
                type="checkbox"
                checked={indexUnique}
                onChange={(e) => setIndexUnique(e.target.checked)}
              />
              {t('insp.unique')}
            </label>
          </AddForm>
        )}
      </Section>

      {!isChild && (
        <Section
          title={t('part.section')}
          count={table.partitionBy ? children.length : undefined}
          action={
            !locked &&
            !isPublished &&
            !activeEditingStrategy &&
            !table.partitionBy && (
              <button type="button" className="btn ghost sm" onClick={openStrategyEditor}>
                {t('part.configure')}
              </button>
            )
          }
        >
          {!table.partitionBy && !activeEditingStrategy && (
            <p className="hint">{isPublished ? t('part.publishedHint') : t('part.notPartitioned')}</p>
          )}

          {table.partitionBy && !activeEditingStrategy && (
            <div className="space-y-2">
              <div className="rounded-sm border border-border bg-surface px-2.5 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="badge font-mono uppercase">{spec?.strategy ?? 'PARTITION'}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-2">
                    {formatPartitionBy(model, table)}
                  </span>
                </div>
                {!locked && !isPublished && (
                  <div className="mt-2 flex items-center gap-1.5">
                    <button type="button" className="btn sm" onClick={openStrategyEditor}>
                      {t('part.editStrategy')}
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={children.length > 0}
                      title={children.length > 0 ? t('part.clearHasChildren') : undefined}
                      onClick={() => ws.act('setPartitionBy', { id: table.id, partitionBy: null })}
                    >
                      {t('part.clearStrategy')}
                    </button>
                  </div>
                )}
              </div>
              {isPublished && <p className="hint">{t('part.publishedHint')}</p>}
            </div>
          )}

          {activeEditingStrategy && (
            <AddForm
              title={t('part.configure')}
              onCancel={() => setEditingStrategy(false)}
              submit={
                <button
                  type="button"
                  className="btn primary"
                  disabled={!strategyValid}
                  onClick={commitStrategy}
                >
                  {t('part.applyStrategy')}
                </button>
              }
            >
              <label className="field">
                <span className="label">{t('part.strategy')}</span>
                <select
                  aria-label={t('part.strategy')}
                  className="select font-mono"
                  value={draftStrategy}
                  onChange={(e) => {
                    const next = e.target.value as PartitionStrategy;
                    setDraftStrategy(next);
                    if (next === 'list' && draftKeys.length > 1) {
                      setDraftKeys((ks) => ks.slice(0, 1));
                    }
                  }}
                >
                  <option value="range">RANGE</option>
                  <option value="list">LIST</option>
                  <option value="hash">HASH</option>
                </select>
              </label>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="label">{t('part.keys')}</span>
                  {draftStrategy !== 'list' && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() =>
                        setDraftKeys((ks) => [
                          ...ks,
                          { mode: 'column', column: cols[0]?.id ?? '', expr: '', collation: '', opclass: '' },
                        ])
                      }
                    >
                      <Plus size={12} aria-hidden="true" />
                      {t('part.addKey')}
                    </button>
                  )}
                </div>
                {draftStrategy === 'list' && <p className="hint">{t('part.listSingleKey')}</p>}

                {draftKeys.map((k, idx) => (
                  <div key={idx} className="space-y-1.5 rounded-sm border border-border bg-surface p-2">
                    <div className="flex items-center gap-1.5">
                      <select
                        aria-label={`${t('part.keyMode')} ${idx + 1}`}
                        className="select w-24 shrink-0"
                        value={k.mode}
                        onChange={(e) => {
                          const mode = e.target.value as 'column' | 'expr';
                          setDraftKeys((ks) => ks.map((item, i) => (i === idx ? { ...item, mode } : item)));
                        }}
                      >
                        <option value="column">{t('part.keyColumn')}</option>
                        <option value="expr">{t('part.keyExpr')}</option>
                      </select>

                      {k.mode === 'column' ? (
                        <select
                          aria-label={`${t('part.pickColumn')} ${idx + 1}`}
                          className="select min-w-0 flex-1 font-mono"
                          value={k.column}
                          onChange={(e) =>
                            setDraftKeys((ks) =>
                              ks.map((item, i) => (i === idx ? { ...item, column: e.target.value } : item)),
                            )
                          }
                        >
                          <option value="">—</option>
                          {cols.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          aria-label={`${t('part.keyExpr')} ${idx + 1}`}
                          className="input min-w-0 flex-1 font-mono"
                          spellCheck={false}
                          placeholder={t('part.keyExprPlaceholder')}
                          value={k.expr}
                          onChange={(e) =>
                            setDraftKeys((ks) =>
                              ks.map((item, i) => (i === idx ? { ...item, expr: e.target.value } : item)),
                            )
                          }
                        />
                      )}

                      {draftKeys.length > 1 && (
                        <IconButton
                          label={`${t('part.removeKey')} ${idx + 1}`}
                          size="sm"
                          onClick={() => setDraftKeys((ks) => ks.filter((_, i) => i !== idx))}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </IconButton>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-1.5">
                      <input
                        aria-label={`${t('part.collation')} ${idx + 1}`}
                        className="input font-mono text-xs"
                        spellCheck={false}
                        placeholder={t('part.collation')}
                        value={k.collation}
                        onChange={(e) =>
                          setDraftKeys((ks) =>
                            ks.map((item, i) => (i === idx ? { ...item, collation: e.target.value } : item)),
                          )
                        }
                      />
                      <input
                        aria-label={`${t('part.opclass')} ${idx + 1}`}
                        className="input font-mono text-xs"
                        spellCheck={false}
                        placeholder={t('part.opclass')}
                        value={k.opclass}
                        onChange={(e) =>
                          setDraftKeys((ks) =>
                            ks.map((item, i) => (i === idx ? { ...item, opclass: e.target.value } : item)),
                          )
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </AddForm>
          )}

          {table.partitionBy && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-1.5">
                <span className="label">{t('part.children')}</span>
                <span className="count">{children.length}</span>
                {!locked && spec && (
                  <span className="ml-auto flex items-center gap-1">
                    <button type="button" className="btn ghost sm" onClick={openAddPartition}>
                      <Plus size={12} aria-hidden="true" />
                      {t('part.addChild')}
                    </button>
                    <button type="button" className="btn ghost sm" onClick={openAttachPartition}>
                      {t('part.attachTable')}
                    </button>
                  </span>
                )}
              </div>

              {children.length > 0 && (
                <ul className="list-none space-y-1 p-0">
                  {children.map((ch) => {
                    const isSubPart = ch.partitionBy !== null;
                    const chIsDefault = parsePartitionBound(ch.partitionOf!.bound)?.kind === 'default';
                    return (
                      <li key={ch.id} className="rounded-sm border border-border bg-surface px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <Layers size={13} aria-hidden="true" className="shrink-0 text-text-3" />
                          <button
                            type="button"
                            className="min-w-0 flex-1 truncate text-left font-mono text-sm hover:underline"
                            disabled={false}
                            onClick={() => onSelect(ch.id)}
                          >
                            {ch.name}
                          </button>
                          {isSubPart && <span className="badge shrink-0">{t('part.subPartitionBadge')}</span>}
                          {!locked && (
                            <span className="flex shrink-0 items-center gap-0.5">
                              {spec && !isSubPart && (
                                <IconButton
                                  label={t('part.editBoundLabel', { name: ch.name })}
                                  size="sm"
                                  onClick={() => openEditBound(ch, spec)}
                                >
                                  <Pencil size={13} aria-hidden="true" />
                                </IconButton>
                              )}
                              {!isSubPart && (
                                <IconButton
                                  label={t('part.detachLabel', { name: ch.name })}
                                  size="sm"
                                  onClick={() => ws.act('detachPartition', { id: ch.id })}
                                >
                                  <Unlink size={13} aria-hidden="true" />
                                </IconButton>
                              )}
                              <IconButton
                                label={t('part.deleteLabel', { name: ch.name })}
                                size="sm"
                                className="hover:!text-danger"
                                onClick={() => ws.act('dropTable', { id: ch.id })}
                              >
                                <Trash2 size={13} aria-hidden="true" />
                              </IconButton>
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 pl-5 font-mono text-xs text-text-3">
                          {ch.partitionOf!.bound}
                        </div>

                        {activeEditingBoundId === ch.id && spec && (
                          <div className="mt-2">
                            <AddForm
                              title={t('part.editBound')}
                              onCancel={() => setEditingBoundId(null)}
                              submit={
                                <button
                                  type="button"
                                  className="btn primary"
                                  disabled={!editBoundStr || !!editBoundError}
                                  onClick={() => {
                                    if (ws.act('setPartitionBound', { id: ch.id, bound: editBoundStr })) {
                                      setEditingBoundId(null);
                                    }
                                  }}
                                >
                                  {t('part.saveBound')}
                                </button>
                              }
                            >
                              <BoundInputs
                                spec={spec}
                                draft={editBoundDraft}
                                onChange={setEditBoundDraft}
                                hasDefault={hasDefaultChild}
                                isSelfDefault={chIsDefault}
                              />
                              {editBoundError && <p className="hint text-danger">{editBoundError}</p>}
                            </AddForm>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {children.length === 0 && activePartForm === null && (
                <p className="hint">{t('part.noChildren')}</p>
              )}

              {activePartForm === 'add' && spec && (
                <AddForm
                  title={t('part.addChild')}
                  onCancel={() => setPartForm(null)}
                  submit={
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!childName.trim() || !formBoundStr || !!formBoundError}
                      onClick={() => {
                        if (
                          ws.act('createPartition', {
                            id: newId(),
                            parent: table.id,
                            name: childName.trim(),
                            bound: formBoundStr,
                          })
                        ) {
                          setPartForm(null);
                        }
                      }}
                    >
                      {t('part.addChild')}
                    </button>
                  }
                >
                  <label className="field">
                    <span className="label">{t('part.childName')}</span>
                    <input
                      aria-label={t('part.childName')}
                      className="input font-mono"
                      spellCheck={false}
                      autoFocus
                      value={childName}
                      onChange={(e) => setChildName(e.target.value)}
                    />
                  </label>
                  <BoundInputs
                    spec={spec}
                    draft={boundDraft}
                    onChange={setBoundDraft}
                    hasDefault={hasDefaultChild}
                  />
                  {formBoundError && <p className="hint text-danger">{formBoundError}</p>}
                </AddForm>
              )}

              {activePartForm === 'attach' && spec && (
                <AddForm
                  title={t('part.attachTable')}
                  onCancel={() => setPartForm(null)}
                  submit={
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!attachTableId || !formBoundStr || !!formBoundError}
                      onClick={() => {
                        if (
                          ws.act('attachPartition', {
                            parent: table.id,
                            child: attachTableId,
                            bound: formBoundStr,
                          })
                        ) {
                          setPartForm(null);
                        }
                      }}
                    >
                      {t('part.attachSubmit')}
                    </button>
                  }
                >
                  {attachCandidates.length === 0 ? (
                    <p className="hint">{t('part.attachNone')}</p>
                  ) : (
                    <>
                      <label className="field">
                        <span className="label">{t('part.attachPickTable')}</span>
                        <select
                          aria-label={t('part.attachPickTable')}
                          className="select font-mono"
                          value={attachTableId}
                          onChange={(e) => setAttachTableId(e.target.value)}
                        >
                          {attachCandidates.map((cand) => (
                            <option key={cand.id} value={cand.id}>
                              {cand.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <BoundInputs
                        spec={spec}
                        draft={boundDraft}
                        onChange={setBoundDraft}
                        hasDefault={hasDefaultChild}
                      />
                      {formBoundError && <p className="hint text-danger">{formBoundError}</p>}
                    </>
                  )}
                </AddForm>
              )}
            </div>
          )}
        </Section>
      )}
    </fieldset>
  );
};

const KIND_ICON = { table: Table2, enum: List, sequence: Hash } as const;

export const Inspector = ({
  selected,
  onSelect,
  ...ctx
}: Ctx & { selected: string | null; onSelect: (id: string | null) => void }) => {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const { ws, readOnly, model } = ctx;

  const o = selected ? model.objects[selected] : undefined;
  if (!o || !['table', 'enum', 'sequence', 'opaque'].includes(o.kind))
    return (
      <div className="p-4">
        <Empty
          icon={<MousePointerClick size={28} strokeWidth={1.5} aria-hidden="true" />}
          title={t('insp.nothingTitle')}
        >
          {t('insp.nothing')}
        </Empty>
      </div>
    );
  const schema = 'parent' in o ? model.objects[o.parent]?.name : undefined;
  const Icon =
    o.kind === 'opaque'
      ? o.objType.includes('iew')
        ? Eye
        : FileCode
      : o.kind === 'table' && o.partitionOf
        ? Layers
        : KIND_ICON[o.kind as keyof typeof KIND_ICON];
  const canDelete = o.kind === 'table' && !readOnly;

  return (
    <>
      <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border pr-2.5 pl-3.5">
        <Icon size={16} aria-hidden="true" className="text-text-3" />
        <h2 className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-lg)] font-semibold">
          {schema && <span className="font-normal text-text-3">{schema}.</span>}
          {o.name}
        </h2>
        {o.kind === 'opaque' && <span className="badge">{o.objType}</span>}
        {canDelete && (
          <Menu
            label={t('insp.more')}
            trigger={<Ellipsis size={16} aria-hidden="true" />}
            items={[
              {
                label: t('insp.deleteTable'),
                icon: <Trash2 size={16} aria-hidden="true" />,
                danger: true,
                onSelect: () => setConfirm(true),
              },
            ]}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3.5 pt-3 pb-5">
        {o.kind === 'table' && <TableInspector key={o.id} table={o} onSelect={onSelect} {...ctx} />}
        {o.kind === 'enum' && (
          <fieldset disabled={readOnly} className="min-w-0 space-y-3 border-0 p-0">
            <Labeled label={t('insp.name')}>
              <Field
                ws={ws}
                label={t('insp.name')}
                value={o.name}
                basisIds={[o.id]}
                mono
                onCommit={(v, b) => ws.act('renameEnum', { id: o.id, name: v.trim() }, b)}
              />
            </Labeled>
            <Section title={t('insp.values')} count={o.values.length}>
              <ul className="flex list-none flex-wrap gap-1.5 p-0">
                {o.values.map((v) => (
                  <li key={v} className="chip font-mono">
                    {v}
                  </li>
                ))}
              </ul>
              <Field
                ws={ws}
                label={t('insp.addValue')}
                placeholder={t('insp.addValue')}
                value=""
                basisIds={[o.id]}
                mono
                onCommit={(v, b) => v.trim() && ws.act('addEnumValue', { id: o.id, value: v.trim() }, b)}
              />
            </Section>
          </fieldset>
        )}
        {o.kind === 'sequence' && (
          <fieldset disabled={readOnly} className="min-w-0 border-0 p-0">
            <Labeled label={t('insp.name')}>
              <Field
                ws={ws}
                label={t('insp.name')}
                value={o.name}
                basisIds={[o.id]}
                mono
                onCommit={(v, b) => ws.act('renameSequence', { id: o.id, name: v.trim() }, b)}
              />
            </Labeled>
          </fieldset>
        )}
        {o.kind === 'opaque' && (
          <div className="space-y-3">
            <Banner kind="info">{t('insp.readonlyObject')}</Banner>
            <pre className="code text-xs">
              <Sql text={`${o.ddl.join(';\n\n')};`} />
            </pre>
          </div>
        )}
      </div>
      {o.kind === 'table' && (
        <Modal
          open={confirm && !readOnly}
          onClose={() => setConfirm(false)}
          size="sm"
          title={t('insp.deleteTableTitle', { name: o.name })}
          footer={
            <form
              method="dialog"
              className="flex w-full justify-end gap-2"
              onSubmit={(e) => {
                if ((e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'delete') {
                  ws.act('dropTable', { id: o.id });
                  onSelect(null);
                }
              }}
            >
              <button type="submit" value="cancel" className="btn" autoFocus>
                {t('dlg.cancel')}
              </button>
              <button type="submit" value="delete" className="btn danger solid">
                {t('insp.deleteTable')}
              </button>
            </form>
          }
        >
          <p className="text-sm text-text-2">{t('insp.deleteTableHint')}</p>
        </Modal>
      )}
    </>
  );
};
