// 属性面板（DESIGN.md：属性面板）：编辑选中的表、枚举、序列；不透明对象只读显示 DDL。
// 输入框是“草稿”：获得焦点时记下所依据对象的版本，保存时一并提交——期间别人改过这些对象，保存会被拒绝（04-ir-design.md 2.3）。
import type { CanvasSection, PublishedTables, VersionInfo } from '@dowel/api';
import {
  all,
  buildModelIndex,
  type Column,
  childrenOf,
  columnsOf,
  deepEqual,
  effectiveColumnsOf,
  type FkAction,
  formatPartitionBound,
  formatPartitionBy,
  getDialect,
  isMssqlIdentityEligibleType,
  isMssqlPkClustered,
  isMysqlAutoIncrementType,
  type Model,
  type ModelIndex,
  MYSQL_SAFE_IDENT_RE,
  mssqlChooseName,
  mssqlDefaultNameOf,
  mssqlNormalizeType,
  newId,
  normalizeType,
  parsePartitionBound,
  partitionKeyColumns,
  type PartitionKey,
  type PartitionSpec,
  type PartitionStrategy,
  resolvePartitionBy,
  splitMysqlTypeModifiers,
  type Table,
  validatePartitionBoundCode,
  withModelIndex,
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
  Focus,
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
import { memo, type ReactNode, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import { dialectUiSpec } from '../dialects.ts';
import { useProject } from '../project.tsx';
import { resolveTopLevelTableId } from '../sections.ts';
import type { Workspace } from '../workspace.ts';
import { shortType, typeLabel } from './Canvas.tsx';
import { Modal } from './Modal.tsx';
import { Banner, cx, Empty, IconButton, Menu, Sql } from './ui.tsx';

type Ctx = { ws: Workspace; model: Model; readOnly: boolean; modelIndex?: ModelIndex };

/** 失焦或回车时提交，Esc 放弃；传入 validate 时仅在失焦/提交时校验并在输入时清除错误 */
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
  describedBy,
  validate,
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
  describedBy?: string;
  validate?: (trimmed: string) => string | null;
}) => {
  const errId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const basis = useRef<Versions>({});
  const draftBaseValue = useRef<string | null>(null);
  const cancelled = useRef(false);
  const ariaDescribedBy = [describedBy, error ? errId : null].filter(Boolean).join(' ') || undefined;
  return (
    <>
      <input
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={ariaDescribedBy}
        value={draft ?? value}
        list={list}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        autoCapitalize={mono ? 'none' : undefined}
        autoCorrect={mono ? 'off' : undefined}
        spellCheck={false}
        className={cx('input', mono && 'font-mono', className)}
        onFocus={() => {
          cancelled.current = false;
          if (draft === null) {
            setDraft(value);
            draftBaseValue.current = value;
            basis.current = ws.client.basisOf(basisIds);
          } else if (value === draftBaseValue.current) {
            basis.current = ws.client.basisOf(basisIds);
          }
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          // 输入法组字中按回车是确认候选词，不是提交（Safari / 部分安卓只给 keyCode 229）
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            cancelled.current = true;
            setError(null);
            e.currentTarget.blur();
          }
        }}
        onBlur={() => {
          if (cancelled.current || draft === null) {
            setDraft(null);
            draftBaseValue.current = null;
            setError(null);
            return;
          }
          if (draft !== value) {
            const err = validate?.(draft.trim()) ?? null;
            if (err) {
              setError(err);
              return;
            }
            setError(null);
            onCommit(draft, basis.current);
          } else {
            setError(null);
          }
          setDraft(null);
          draftBaseValue.current = null;
        }}
      />
      {error && (
        <p id={errId} className="hint error">
          {error}
        </p>
      )}
    </>
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

/** 解析类型输入：枚举名（可带 schema、可带 []）→ typeRef；否则规范化成当前方言的写法 */
const parseType = (m: Model, text: string, index?: ModelIndex): { type: string; typeRef: string | null } => {
  const arr = /(\[\])*$/.exec(text.trim())![0];
  const base = text.trim().slice(0, text.trim().length - arr.length);
  const enums = getDialect(m.dialect).capabilities.enums
    ? index
      ? index.allRef('enum')
      : all(m, 'enum')
    : null;
  const e = enums
    ? enums.find((x) => x.name === base || `${m.objects[x.parent]?.name}.${x.name}` === base)
    : undefined;
  return e ? { type: arr, typeRef: e.id } : { type: normalizeType(text, m.dialect), typeRef: null };
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

const evaluateBoundDraft = (
  spec: PartitionSpec,
  draft: BoundDraft,
): { bound: string; errorKey: string | null; errorParams?: Record<string, string | number> } => {
  if (draft.isDefault && spec.strategy !== 'hash') {
    return { bound: formatPartitionBound({ kind: 'default' }), errorKey: null };
  }
  let bound = '';
  if (spec.strategy === 'range') {
    const from = draft.from.map((s) => s.trim());
    const to = draft.to.map((s) => s.trim());
    if (from.some((v) => !v) || to.some((v) => !v)) return { bound: '', errorKey: null };
    bound = formatPartitionBound({ kind: 'range', from, to });
  } else if (spec.strategy === 'list') {
    const raw = draft.list.trim();
    if (!raw) return { bound: '', errorKey: null };
    bound = `FOR VALUES IN (${raw})`;
  } else {
    const modText = draft.modulus.trim();
    const remText = draft.remainder.trim();
    if (!modText || !remText) return { bound: '', errorKey: null };
    if (!/^\d+$/.test(modText) || !/^\d+$/.test(remText)) {
      return { bound: '', errorKey: 'part.boundErr.hash_integer' };
    }
    const modulus = Number(modText);
    const remainder = Number(remText);
    if (!Number.isSafeInteger(modulus) || !Number.isSafeInteger(remainder)) {
      return { bound: '', errorKey: 'part.boundErr.hash_integer' };
    }
    bound = formatPartitionBound({ kind: 'hash', modulus, remainder });
  }
  const err = validatePartitionBoundCode(spec.strategy, bound, spec.keys.length);
  if (!err) return { bound, errorKey: null };
  const { code, ...params } = err;
  return { bound, errorKey: `part.boundErr.${code}`, errorParams: params };
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

/** 筛选列定义、主键与 CHECK 约束均与分区父表兼容、可挂载为子分区的普通表（与 edit.ts attachPartition 对齐） */
const compatiblePlainTables = (model: Model, parent: Table, index?: ModelIndex): Table[] => {
  const compute = (): Table[] => {
    const rootCols = effectiveColumnsOf(model, parent.id);
    const ancestorIds = new Set<string>();
    for (let cur: Table | undefined = parent; cur && !ancestorIds.has(cur.id);) {
      ancestorIds.add(cur.id);
      cur = cur.partitionOf ? (model.objects[cur.partitionOf.parent] as Table | undefined) : undefined;
    }
    const ancPks = all(model, 'primaryKey').filter((k) => ancestorIds.has(k.parent));
    const ancChecks = all(model, 'check').filter((k) => ancestorIds.has(k.parent));
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
      const colMap = new Map<string, string>();
      for (const rc of rootCols) {
        const cc = cols.find((x) => x.name === rc.name);
        if (!cc) return false;
        if (
          cc.type !== rc.type ||
          cc.typeRef !== rc.typeRef ||
          cc.collation !== rc.collation ||
          cc.notNull !== rc.notNull ||
          !deepEqual(cc.generated, rc.generated) ||
          !deepEqual(cc.default, rc.default)
        ) {
          return false;
        }
        colMap.set(cc.id, rc.id);
      }
      const candPk = childrenOf(model, cand.id, 'primaryKey')[0];
      if (candPk && ancPks.length > 0) {
        const mapped = candPk.columns.map((c) => colMap.get(c) ?? c);
        if (!ancPks.some((pk) => deepEqual(pk.columns, mapped))) return false;
      }
      for (const ck of childrenOf(model, cand.id, 'check')) {
        if (ancChecks.some((ak) => ak.name === ck.name && (ak.expr !== ck.expr || ck.noInherit)))
          return false;
      }
      return true;
    });
  };
  return index ? withModelIndex(model, compute, index) : compute();
};

interface KeyDraft {
  mode: 'column' | 'expr';
  column: string;
  expr: string;
  collation: string;
  opclass: string;
}

const isIntegerColumn = (c: Column) =>
  !c.typeRef && (c.type === 'smallint' || c.type === 'integer' || c.type === 'bigint');

const MYSQL_UNSIGNED_BASE_TYPES = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'bigint',
  'decimal',
  'float',
  'double',
]);

const isMysqlUnsignedEligible = (type: string): boolean => {
  const base = splitMysqlTypeModifiers(type)
    .baseType.replace(/\([^)]*\)/, '')
    .trim()
    .toLowerCase();
  return MYSQL_UNSIGNED_BASE_TYPES.has(base);
};

const isMysqlOnUpdateTemporalType = (type: string): boolean =>
  /^(?:datetime|timestamp)(?:\(\d+\))?$/i.test(splitMysqlTypeModifiers(type).baseType.trim());

type MysqlIndexType = 'BTREE' | 'HASH' | 'FULLTEXT' | 'SPATIAL';
const MYSQL_INDEX_TYPES: readonly MysqlIndexType[] = ['BTREE', 'HASH', 'FULLTEXT', 'SPATIAL'];

const parseFillFactorInput = (raw: string): number | null | 'invalid' => {
  const s = raw.trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return 'invalid';
  const n = Number.parseInt(s, 10);
  if (!Number.isInteger(n) || n < 1 || n > 100) return 'invalid';
  return n;
};

const TableInspector = ({
  table,
  ws,
  model,
  modelIndex,
  readOnly,
  onSelect,
  sections,
  onSetSections,
}: Ctx & {
  table: Table;
  onSelect: (id: string | null) => void;
  sections?: CanvasSection[];
  onSetSections?: (next: CanvasSection[]) => void;
}) => {
  const { t } = useTranslation();
  const { pid, project } = useProject();
  const dialectSpec = getDialect(model.dialect);
  const uiSpec = dialectUiSpec(model.dialect);
  const idx = useMemo(() => modelIndex ?? buildModelIndex(model), [model, modelIndex]);
  const versions = useQuery({
    queryKey: ['versions', pid],
    queryFn: () => api<VersionInfo[]>('GET', `/api/projects/${pid}/versions`),
    refetchOnMount: false,
  });
  const versionCount = versions.data?.length ?? 0;
  const latestId = versions.data?.[0]?.id;
  const publishedTables = useQuery({
    queryKey: ['published-tables', pid, latestId, versionCount],
    queryFn: async () => {
      const res = await api<PublishedTables>('GET', `/api/projects/${pid}/published-tables`);
      return new Set(res.tableIds);
    },
    enabled: versionCount > 0,
    staleTime: Infinity,
  });
  // Fail-closed：版本列表或已发布表集合仍在加载/重拉/出错时，默认锁定策略编辑，避免发布后短暂暴露非法操作
  const publishedUnknown =
    versions.isPending ||
    versions.isFetching ||
    versions.isError ||
    (versionCount > 0 &&
      (publishedTables.isPending || publishedTables.isFetching || publishedTables.isError));
  const isPublished = !publishedUnknown && versionCount > 0 && !!publishedTables.data?.has(table.id);
  const pgBlocksPartitionIdentity =
    model.dialect === 'pg' && project.targetPgMajor !== null && project.targetPgMajor < 17;

  const isChild = table.partitionOf !== null;
  const cols = isChild
    ? withModelIndex(model, () => effectiveColumnsOf(model, table.id), idx)
    : idx.columnsOf(table.id);
  const pk = idx.childrenRef(table.id, 'primaryKey')[0];
  const checks = idx.childrenRef(table.id, 'check');
  const uniques = idx.childrenRef(table.id, 'unique');
  const fks = idx.childrenRef(table.id, 'foreignKey');
  const indexes = idx.childrenRef(table.id, 'index');
  const tableIds = [table.id, ...cols.map((c) => c.id)];
  const name = (id: string) => model.objects[id]?.name ?? '?';
  const locked = readOnly;
  const fkCols = new Set(fks.flatMap((f) => f.columns));

  const partKeyCols = useMemo(() => {
    const ids = new Set<string>();
    const tablesToScan = isChild ? [table] : [table, ...idx.partitionDescendants(table.id)];
    for (const tb of tablesToScan) {
      if (tb.partitionBy) {
        for (const id of partitionKeyColumns(model, tb).all) ids.add(id);
      }
    }
    return ids;
  }, [idx, isChild, model, table]);

  const spec = table.partitionBy ? resolvePartitionBy(model, table) : null;
  const children = idx.partitionsOf(table.id);
  const parentTable = table.partitionOf
    ? (model.objects[table.partitionOf.parent] as Table | undefined)
    : undefined;
  const parentSpec = parentTable?.partitionBy ? resolvePartitionBy(model, parentTable) : null;
  const hasDefaultChild = children.some((c) => parsePartitionBound(c.partitionOf!.bound)?.kind === 'default');
  const parentHasDefault = parentTable
    ? idx
        .partitionsRef(parentTable.id)
        .some((c) => parsePartitionBound(c.partitionOf!.bound)?.kind === 'default')
    : false;
  const selfIsDefault = !!(
    table.partitionOf && parsePartitionBound(table.partitionOf.bound)?.kind === 'default'
  );

  const [openCol, setOpenCol] = useState<string | null>(null);
  const [focusNew, setFocusNew] = useState<string | null>(null);
  const [adding, setAdding] = useState<'check' | 'unique' | 'fk' | 'index' | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [indexUnique, setIndexUnique] = useState(false);
  const [uniqueClustered, setUniqueClustered] = useState(false);
  const [mysqlIndexType, setMysqlIndexType] = useState<MysqlIndexType>('BTREE');
  const [mssqlIndexClustered, setMssqlIndexClustered] = useState(false);
  const [mssqlFillFactor, setMssqlFillFactor] = useState('');
  const [mssqlFillFactorErr, setMssqlFillFactorErr] = useState<string | null>(null);
  const emptyFk = { col: '', ref: '', refCol: '', onDelete: 'noAction' as FkAction };
  const [fk, setFk] = useState(emptyFk);
  const typesId = useId();
  const mysqlTypeHintId = useId();
  const fillFactorErrId = useId();

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

  const strategyLocked = locked || publishedUnknown || isPublished;
  const activeAdding = locked ? null : adding;
  const activeEditingStrategy = !strategyLocked && !isChild && editingStrategy;
  const activePartForm = locked || isChild ? null : partForm;
  const activeEditingBoundId = locked ? null : editingBoundId;
  const identityCols = cols.filter((c) => c.identity !== null);

  const startAdding = (k: typeof adding) => {
    setAdding(k);
    setPicked([]);
    setIndexUnique(false);
    setUniqueClustered(false);
    setMysqlIndexType('BTREE');
    setMssqlIndexClustered(false);
    setMssqlFillFactor('');
    setMssqlFillFactorErr(null);
    setFk(emptyFk);
  };
  const validateMysqlSafeIdent = (trimmed: string): string | null =>
    trimmed && !MYSQL_SAFE_IDENT_RE.test(trimmed) ? t('insp.mysqlSafeIdentErr') : null;
  const hasOtherClustered = (excludeId: string): boolean =>
    (pk !== undefined && pk.id !== excludeId && isMssqlPkClustered(model, pk)) ||
    uniques.some((u) => u.id !== excludeId && !!u.ext?.mssql?.clustered) ||
    indexes.some((ix) => ix.id !== excludeId && !!ix.ext?.mssql?.clustered);
  const isMysqlColIndexedFirst = (colId: string): boolean =>
    pk?.columns[0] === colId ||
    uniques.some((u) => u.columns[0] === colId) ||
    indexes.some((ix) => {
      const it = (ix.ext?.mysql?.indexType ?? ix.method).toUpperCase();
      return it !== 'FULLTEXT' && it !== 'SPATIAL' && ix.elements[0]?.column === colId;
    });
  const updateMysqlTableExt = (
    patch: Partial<{ engine: string; charset: string; collation: string }>,
    basis?: Versions,
  ) => {
    const nextMysql = { ...table.ext?.mysql, ...patch };
    const nextExt = { ...table.ext, mysql: nextMysql };
    ws.act('setTableExt', { id: table.id, ext: nextExt }, basis);
  };
  const updateMysqlColumnExt = (
    c: Column,
    patch: Partial<{
      unsigned: boolean;
      zerofill: boolean;
      autoIncrement: boolean;
      onUpdateCurrentTimestamp: boolean;
      charset: string;
    }>,
    basis?: Versions,
  ) => {
    const nextMysql = { ...c.ext?.mysql, ...patch };
    ws.act('setColumnExt', { id: c.id, ext: { ...c.ext, mysql: nextMysql } }, basis);
  };
  const updateMssqlColumnExt = (
    c: Column,
    patch: Partial<{
      identity: { seed: string; increment: string };
      defaultName: string;
      defaultNameMode: 'derived' | 'explicit';
      sparse: boolean;
      rowguidcol: boolean;
    }>,
    basis?: Versions,
  ) => {
    const nextMssql = { ...c.ext?.mssql, ...patch };
    ws.act('setColumnExt', { id: c.id, ext: { ...c.ext, mssql: nextMssql } }, basis);
  };
  const resetMssqlDefaultName = (c: Column, b?: Versions) => {
    const derived =
      c.default !== null
        ? mssqlChooseName('DF', table.name, c.name, (n) =>
            getDialect('mssql').isNameTaken(model, 'rel', table.parent, n, `${c.id}#df`),
          )
        : undefined;
    updateMssqlColumnExt(
      c,
      derived
        ? { defaultName: derived, defaultNameMode: 'derived' }
        : { defaultName: undefined, defaultNameMode: undefined },
      b,
    );
  };
  const setPk = (colId: string, on: boolean) => {
    if (on && model.dialect === 'mssql' && cols.find((c) => c.id === colId)?.ext?.mssql?.sparse) return;
    const next = on ? [...(pk?.columns ?? []), colId] : (pk?.columns ?? []).filter((c) => c !== colId);
    ws.act('setPrimaryKey', { id: newId(), table: table.id, columns: next });
  };
  // 外键可引用的列：被引用表上单列主键或唯一约束的列
  const refCols = fk.ref
    ? [...idx.childrenRef(fk.ref, 'primaryKey'), ...idx.childrenRef(fk.ref, 'unique')]
        .filter((k) => k.columns.length === 1)
        .map((k) => k.columns[0]!)
    : [];
  const addColumn = () => {
    let n = cols.length + 1;
    while (cols.some((c) => c.name === `column_${n}`)) n++;
    const id = newId();
    if (
      ws.act('addColumn', {
        table: table.id,
        column: { id, name: `column_${n}`, type: uiSpec.defaultColumnType },
      })
    ) {
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
    const allTables = idx.allRef('table');
    while (allTables.some((x) => x.name === `${table.name}_p${n}`)) n++;
    setChildName(`${table.name}_p${n}`);
    setBoundDraft(initBoundDraft(spec));
    setPartForm('add');
  };

  const openAttachPartition = () => {
    if (!spec) return;
    const cands = compatiblePlainTables(model, table, idx);
    setAttachTableId(cands[0]?.id ?? '');
    setBoundDraft(initBoundDraft(spec));
    setPartForm('attach');
  };

  const openEditBound = (target: Table, activeSpec: PartitionSpec) => {
    setEditBoundDraft(initBoundDraft(activeSpec, target.partitionOf?.bound));
    setEditingBoundId(target.id);
  };

  const attachCandidates = activePartForm === 'attach' ? compatiblePlainTables(model, table, idx) : [];
  const enumNames = useMemo(
    () => (dialectSpec.capabilities.enums ? idx.allRef('enum').map((e) => e.name) : []),
    [dialectSpec.capabilities.enums, idx],
  );
  const formBoundEval = spec ? evaluateBoundDraft(spec, boundDraft) : { bound: '', errorKey: null };
  const formBoundStr = formBoundEval.bound;
  const formBoundError = formBoundEval.errorKey
    ? t(formBoundEval.errorKey, formBoundEval.errorParams ?? {})
    : null;

  const activeEditSpec = isChild ? parentSpec : spec;
  const editBoundEval = activeEditSpec
    ? evaluateBoundDraft(activeEditSpec, editBoundDraft)
    : { bound: '', errorKey: null };
  const editBoundStr = editBoundEval.bound;
  const editBoundError = editBoundEval.errorKey
    ? t(editBoundEval.errorKey, editBoundEval.errorParams ?? {})
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
      {dialectSpec.capabilities.comments && (
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
      )}
      {model.dialect === 'sqlite' && (
        <div className="field">
          <span className="label">{t('insp.sqliteOptions')}</span>
          <div className="checks">
            <label>
              <input
                type="checkbox"
                checked={!!table.ext?.sqlite?.strict}
                onChange={(e) => {
                  const next = { ...table.ext?.sqlite, strict: e.target.checked };
                  ws.act('setTableExt', {
                    id: table.id,
                    ext: next.strict || next.withoutRowid ? { ...table.ext, sqlite: next } : null,
                  });
                }}
              />
              {t('insp.sqliteStrict')}
            </label>
            <label>
              <input
                type="checkbox"
                checked={!!table.ext?.sqlite?.withoutRowid}
                disabled={!pk}
                onChange={(e) => {
                  const next = { ...table.ext?.sqlite, withoutRowid: e.target.checked };
                  ws.act('setTableExt', {
                    id: table.id,
                    ext: next.strict || next.withoutRowid ? { ...table.ext, sqlite: next } : null,
                  });
                }}
              />
              {t('insp.sqliteWithoutRowid')}
            </label>
          </div>
        </div>
      )}

      {model.dialect === 'mysql' && (
        <div className="space-y-2">
          <div className="label">{t('insp.mysqlTableOptions')}</div>
          <div className="grid grid-cols-2 gap-2">
            <Labeled label={t('insp.mysqlEngine')}>
              <Field
                ws={ws}
                label={t('insp.mysqlEngine')}
                placeholder="InnoDB"
                value={table.ext?.mysql?.engine ?? ''}
                basisIds={[table.id]}
                mono
                validate={validateMysqlSafeIdent}
                onCommit={(v, b) => updateMysqlTableExt({ engine: v.trim() || undefined }, b)}
              />
            </Labeled>
            <Labeled label={t('insp.mysqlCharset')}>
              <Field
                ws={ws}
                label={t('insp.mysqlCharset')}
                placeholder="utf8mb4"
                value={table.ext?.mysql?.charset ?? ''}
                basisIds={[table.id]}
                mono
                validate={validateMysqlSafeIdent}
                onCommit={(v, b) => updateMysqlTableExt({ charset: v.trim() || undefined }, b)}
              />
            </Labeled>
          </div>
          <Labeled label={t('insp.mysqlCollation')}>
            <Field
              ws={ws}
              label={t('insp.mysqlCollation')}
              placeholder="utf8mb4_0900_ai_ci"
              value={table.ext?.mysql?.collation ?? ''}
              basisIds={[table.id]}
              mono
              validate={validateMysqlSafeIdent}
              onCommit={(v, b) => updateMysqlTableExt({ collation: v.trim() || undefined }, b)}
            />
          </Labeled>
        </div>
      )}

      {isChild && table.partitionOf && (
        <Section
          title={t('part.bound')}
          action={
            !locked &&
            !table.partitionBy && (
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
          {activeEditingBoundId === table.id && !table.partitionBy && parentSpec && (
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
            {[
              ...dialectSpec.commonTypes,
              ...(model.dialect === 'mysql' ? ["enum('a','b')", "set('x','y')"] : []),
              ...enumNames,
            ].map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        )}
        <ul className="list-none overflow-hidden rounded-sm border border-border bg-surface p-0">
          {cols.map((c, i) => {
            const open = !isChild && openCol === c.id;
            const isPk = !!pk?.columns.includes(c.id);
            const isPartKey = partKeyCols.has(c.id);
            const mysqlSplit = open && model.dialect === 'mysql' ? splitMysqlTypeModifiers(c.type) : null;
            const isMysqlUnsigned =
              !!mysqlSplit && !!(c.ext?.mysql?.unsigned || mysqlSplit.unsigned || c.ext?.mysql?.zerofill);
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
                          describedBy={model.dialect === 'mysql' ? mysqlTypeHintId : undefined}
                          onCommit={(v, b) => {
                            const parsed = parseType(model, v, idx);
                            if (model.dialect === 'mysql') {
                              const { baseType, unsigned, zerofill } = splitMysqlTypeModifiers(parsed.type);
                              let usedTypeOp = false;
                              if (baseType !== c.type || parsed.typeRef !== c.typeRef) {
                                if (
                                  !ws.act(
                                    'setColumnType',
                                    { id: c.id, type: baseType, typeRef: parsed.typeRef },
                                    b,
                                  )
                                )
                                  return;
                                usedTypeOp = true;
                              }
                              if (
                                (unsigned || zerofill) &&
                                c.generated === null &&
                                isMysqlUnsignedEligible(baseType)
                              ) {
                                updateMysqlColumnExt(
                                  c,
                                  { unsigned: true, ...(zerofill ? { zerofill: true } : {}) },
                                  usedTypeOp ? undefined : b,
                                );
                              } else if (
                                !isMysqlUnsignedEligible(baseType) &&
                                (c.ext?.mysql?.unsigned || c.ext?.mysql?.zerofill)
                              ) {
                                updateMysqlColumnExt(
                                  c,
                                  { unsigned: undefined, zerofill: undefined },
                                  usedTypeOp ? undefined : b,
                                );
                              }
                              return;
                            }
                            ws.act('setColumnType', { id: c.id, ...parsed }, b);
                          }}
                        />
                      </Labeled>
                    </div>
                    {model.dialect === 'mysql' && (
                      <p id={mysqlTypeHintId} className="hint m-0">
                        {t('insp.mysqlTypeHint')}
                      </p>
                    )}
                    {isPartKey && <p className="hint">{t('part.keyColLockedHint')}</p>}
                    <Labeled label={t('insp.default')}>
                      <Field
                        ws={ws}
                        label={`${t('insp.default')} ${c.name}`}
                        placeholder={t('insp.none')}
                        value={defaultText(c)}
                        basisIds={[c.id]}
                        mono
                        disabled={
                          c.generated !== null ||
                          !!c.ext?.mysql?.autoIncrement ||
                          !!c.ext?.mssql?.identity ||
                          (model.dialect === 'mssql' && !!c.ext?.mssql?.sparse)
                        }
                        onCommit={(v, b) => {
                          const trimmed = v.trim();
                          if (trimmed && model.dialect === 'mssql' && !!c.ext?.mssql?.sparse) return;
                          ws.act('setDefault', { id: c.id, default: trimmed ? { expr: trimmed } : null }, b);
                        }}
                      />
                    </Labeled>
                    {c.generated && (
                      <div className="space-y-1 rounded-sm border border-border bg-surface px-2 py-1.5">
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="label m-0">{t('insp.generated')}</span>
                          <span className="badge font-mono">
                            {model.dialect === 'mssql'
                              ? c.generated.stored
                                ? t('insp.generatedPersisted')
                                : t('insp.generatedVirtual')
                              : c.generated.stored
                                ? t('insp.generatedStored')
                                : t('insp.generatedVirtual')}
                          </span>
                        </div>
                        <div className="truncate font-mono text-xs text-text-2">{c.generated.expr}</div>
                      </div>
                    )}
                    {c.collation !== null && (
                      <div className="space-y-0.5 rounded-sm border border-border bg-surface px-2 py-1.5">
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="label m-0">{t('insp.collation')}</span>
                          <span className="truncate font-mono text-xs text-text-2">{c.collation}</span>
                        </div>
                        <p className="hint m-0">{t('insp.collationReadonlyHint')}</p>
                      </div>
                    )}
                    <div className="flex items-center gap-1">
                      <div className="checks flex-1">
                        <label>
                          <input
                            type="checkbox"
                            checked={c.notNull}
                            disabled={
                              c.identity !== null ||
                              !!c.ext?.mssql?.identity ||
                              !!c.ext?.mysql?.autoIncrement ||
                              (model.dialect === 'mssql' && c.generated !== null && !c.generated.stored) ||
                              (model.dialect === 'mssql' && !c.notNull && !!c.ext?.mssql?.sparse)
                            }
                            onChange={(e) => {
                              const on = e.target.checked;
                              if (on && model.dialect === 'mssql' && !!c.ext?.mssql?.sparse) return;
                              ws.act('setNotNull', { id: c.id, notNull: on });
                            }}
                          />
                          {t('insp.notNull')}
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={isPk}
                            disabled={model.dialect === 'mssql' && !isPk && !!c.ext?.mssql?.sparse}
                            onChange={(e) => setPk(c.id, e.target.checked)}
                          />
                          {t('insp.pk')}
                        </label>
                        {model.dialect === 'pg' && (isIntegerColumn(c) || c.identity !== null) && (
                          <label
                            title={
                              table.partitionBy !== null && pgBlocksPartitionIdentity && !c.identity
                                ? t('part.identityRequiresPg17', { target: project.targetPgMajor })
                                : undefined
                            }
                          >
                            <input
                              type="checkbox"
                              checked={c.identity !== null}
                              disabled={
                                c.generated !== null ||
                                (table.partitionBy !== null && pgBlocksPartitionIdentity && !c.identity)
                              }
                              onChange={(e) =>
                                ws.act('setIdentity', {
                                  id: c.id,
                                  identity: e.target.checked ? { always: false } : null,
                                })
                              }
                            />
                            {t('part.identity')}
                          </label>
                        )}
                        {model.dialect === 'sqlite' &&
                          isPk &&
                          pk?.columns.length === 1 &&
                          c.type.toUpperCase() === 'INTEGER' &&
                          !table.ext?.sqlite?.withoutRowid && (
                            <label>
                              <input
                                type="checkbox"
                                checked={!!c.ext?.sqlite?.autoincrement}
                                disabled={c.generated !== null}
                                onChange={(e) =>
                                  ws.act('setColumnExt', {
                                    id: c.id,
                                    ext: e.target.checked
                                      ? { ...c.ext, sqlite: { autoincrement: true } }
                                      : null,
                                  })
                                }
                              />
                              {t('insp.sqliteAutoincrement')}
                            </label>
                          )}
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
                            : (model.dialect === 'sqlite' || model.dialect === 'mysql') && cols.length <= 1
                              ? model.dialect === 'sqlite'
                                ? t('insp.sqliteLastColumnLocked', { name: c.name })
                                : t('insp.lastColumnLocked', { name: c.name, dialect: uiSpec.name })
                              : `${t('insp.delete')} ${c.name}`
                        }
                        size="sm"
                        disabled={
                          isPartKey ||
                          ((model.dialect === 'sqlite' || model.dialect === 'mysql') && cols.length <= 1)
                        }
                        className="hover:!text-danger"
                        onClick={() => ws.act('dropColumn', { id: c.id })}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </IconButton>
                    </div>
                    {model.dialect === 'mysql' && mysqlSplit && (
                      <div className="space-y-2 border-t border-border pt-2">
                        <div className="checks">
                          <label>
                            <input
                              type="checkbox"
                              checked={isMysqlUnsigned}
                              disabled={
                                !isMysqlUnsigned && (c.generated !== null || !isMysqlUnsignedEligible(c.type))
                              }
                              onChange={(e) => {
                                const on = e.target.checked;
                                if (on) {
                                  updateMysqlColumnExt(c, { unsigned: true });
                                } else {
                                  if (mysqlSplit.unsigned || mysqlSplit.zerofill) {
                                    if (
                                      !ws.act('setColumnType', {
                                        id: c.id,
                                        type: mysqlSplit.baseType,
                                        typeRef: c.typeRef,
                                      })
                                    ) {
                                      return;
                                    }
                                  }
                                  updateMysqlColumnExt(c, { unsigned: undefined, zerofill: undefined });
                                }
                              }}
                            />
                            {t('insp.mysqlUnsigned')}
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={!!c.ext?.mysql?.autoIncrement}
                              disabled={
                                !c.ext?.mysql?.autoIncrement &&
                                (c.generated !== null ||
                                  c.default !== null ||
                                  !isMysqlAutoIncrementType(c.type) ||
                                  cols.some((x) => x.id !== c.id && !!x.ext?.mysql?.autoIncrement))
                              }
                              onChange={(e) => {
                                const on = e.target.checked;
                                if (on && !c.notNull) {
                                  ws.act('setNotNull', { id: c.id, notNull: true });
                                }
                                updateMysqlColumnExt(c, { autoIncrement: on ? true : undefined });
                              }}
                            />
                            {t('insp.mysqlAutoIncrement')}
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={!!c.ext?.mysql?.onUpdateCurrentTimestamp}
                              disabled={
                                !c.ext?.mysql?.onUpdateCurrentTimestamp &&
                                (c.generated !== null || !isMysqlOnUpdateTemporalType(c.type))
                              }
                              onChange={(e) =>
                                updateMysqlColumnExt(c, {
                                  onUpdateCurrentTimestamp: e.target.checked ? true : undefined,
                                })
                              }
                            />
                            {t('insp.mysqlOnUpdateCurrentTimestamp')}
                          </label>
                        </div>
                        {c.ext?.mysql?.autoIncrement && !isMysqlColIndexedFirst(c.id) && (
                          <p className="hint m-0 text-warn">{t('insp.mysqlAutoIncrementIndexHint')}</p>
                        )}
                        <Labeled label={t('insp.mysqlCharset')}>
                          <Field
                            ws={ws}
                            label={`${t('insp.mysqlCharset')} ${c.name}`}
                            placeholder="utf8mb4"
                            value={c.ext?.mysql?.charset ?? ''}
                            basisIds={[c.id]}
                            mono
                            validate={validateMysqlSafeIdent}
                            onCommit={(v, b) =>
                              updateMysqlColumnExt(c, { charset: v.trim() || undefined }, b)
                            }
                          />
                        </Labeled>
                      </div>
                    )}
                    {model.dialect === 'mssql' && (
                      <div className="space-y-2 border-t border-border pt-2">
                        <div className="checks">
                          <label>
                            <input
                              type="checkbox"
                              checked={!!c.ext?.mssql?.identity}
                              disabled={
                                !c.ext?.mssql?.identity &&
                                (c.generated !== null ||
                                  c.default !== null ||
                                  !!c.ext?.mssql?.sparse ||
                                  !isMssqlIdentityEligibleType(c.type) ||
                                  cols.some((x) => x.id !== c.id && !!x.ext?.mssql?.identity))
                              }
                              onChange={(e) => {
                                const on = e.target.checked;
                                if (on && !c.notNull) {
                                  ws.act('setNotNull', { id: c.id, notNull: true });
                                }
                                updateMssqlColumnExt(c, {
                                  identity: on ? { seed: '1', increment: '1' } : undefined,
                                });
                              }}
                            />
                            {t('insp.mssqlIdentity')}
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={!!c.ext?.mssql?.sparse}
                              disabled={
                                !c.ext?.mssql?.sparse &&
                                (c.notNull ||
                                  isPk ||
                                  c.default !== null ||
                                  !!c.ext?.mssql?.identity ||
                                  c.generated !== null ||
                                  !!c.ext?.mssql?.rowguidcol)
                              }
                              onChange={(e) => {
                                const on = e.target.checked;
                                if (
                                  on &&
                                  (c.notNull ||
                                    isPk ||
                                    c.default !== null ||
                                    !!c.ext?.mssql?.identity ||
                                    c.generated !== null ||
                                    !!c.ext?.mssql?.rowguidcol)
                                ) {
                                  return;
                                }
                                updateMssqlColumnExt(c, { sparse: on ? true : undefined });
                              }}
                            />
                            {t('insp.mssqlSparse')}
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={!!c.ext?.mssql?.rowguidcol}
                              disabled={
                                !c.ext?.mssql?.rowguidcol &&
                                (mssqlNormalizeType(c.type) !== 'uniqueidentifier' ||
                                  !!c.ext?.mssql?.sparse ||
                                  c.generated !== null)
                              }
                              onChange={(e) =>
                                updateMssqlColumnExt(c, { rowguidcol: e.target.checked ? true : undefined })
                              }
                            />
                            {t('insp.mssqlRowguidcol')}
                          </label>
                        </div>
                        {c.ext?.mssql?.identity && (
                          <div className="grid grid-cols-2 gap-2">
                            <Labeled label={t('insp.mssqlIdentitySeed')}>
                              <Field
                                ws={ws}
                                label={`${t('insp.mssqlIdentitySeed')} ${c.name}`}
                                value={c.ext.mssql.identity.seed}
                                basisIds={[c.id]}
                                mono
                                validate={(v) => (/^-?\d+$/.test(v) ? null : t('insp.mssqlIdentityIntErr'))}
                                onCommit={(v, b) =>
                                  updateMssqlColumnExt(
                                    c,
                                    {
                                      identity: {
                                        seed: v.trim(),
                                        increment: c.ext?.mssql?.identity?.increment ?? '1',
                                      },
                                    },
                                    b,
                                  )
                                }
                              />
                            </Labeled>
                            <Labeled label={t('insp.mssqlIdentityIncrement')}>
                              <Field
                                ws={ws}
                                label={`${t('insp.mssqlIdentityIncrement')} ${c.name}`}
                                value={c.ext.mssql.identity.increment}
                                basisIds={[c.id]}
                                mono
                                validate={(v) => {
                                  if (!/^-?\d+$/.test(v)) return t('insp.mssqlIdentityIntErr');
                                  if (Number.parseInt(v, 10) === 0) return t('insp.mssqlIdentityIncZeroErr');
                                  return null;
                                }}
                                onCommit={(v, b) =>
                                  updateMssqlColumnExt(
                                    c,
                                    {
                                      identity: {
                                        seed: c.ext?.mssql?.identity?.seed ?? '1',
                                        increment: v.trim(),
                                      },
                                    },
                                    b,
                                  )
                                }
                              />
                            </Labeled>
                          </div>
                        )}
                        {(c.default !== null || !!c.ext?.mssql?.defaultName) && (
                          <div className="field">
                            <div className="flex items-center justify-between gap-1.5">
                              <span className="label m-0" aria-hidden="true">
                                {t('insp.mssqlDefaultName')}
                              </span>
                              <span className="flex items-center gap-1">
                                <span className="badge font-mono">
                                  {c.ext?.mssql?.defaultNameMode === 'explicit'
                                    ? t('insp.mssqlDefaultNameExplicit')
                                    : t('insp.mssqlDefaultNameDerived')}
                                </span>
                                {c.ext?.mssql?.defaultNameMode === 'explicit' && (
                                  <button
                                    type="button"
                                    className="btn ghost sm"
                                    onClick={() => resetMssqlDefaultName(c)}
                                  >
                                    {t('insp.mssqlDefaultNameReset')}
                                  </button>
                                )}
                              </span>
                            </div>
                            <Field
                              ws={ws}
                              label={`${t('insp.mssqlDefaultName')} ${c.name}`}
                              placeholder={mssqlDefaultNameOf(c, table.name)}
                              value={c.ext?.mssql?.defaultName ?? ''}
                              basisIds={[c.id, table.id]}
                              mono
                              onCommit={(v, b) => {
                                const trimmed = v.trim();
                                if (trimmed) {
                                  updateMssqlColumnExt(
                                    c,
                                    { defaultName: trimmed, defaultNameMode: 'explicit' },
                                    b,
                                  );
                                } else {
                                  resetMssqlDefaultName(c, b);
                                }
                              }}
                            />
                          </div>
                        )}
                      </div>
                    )}
                    {table.partitionBy !== null &&
                      pgBlocksPartitionIdentity &&
                      (isIntegerColumn(c) || c.identity !== null) && (
                        <p className={cx('hint', c.identity && 'text-warn')}>
                          {t('part.identityRequiresPg17', { target: project.targetPgMajor })}
                        </p>
                      )}
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
              <div>
                {model.dialect === 'mssql' &&
                  `${isMssqlPkClustered(model, pk) ? 'CLUSTERED' : 'NONCLUSTERED'} `}
                ({pk.columns.map(name).join(', ')})
              </div>
              {model.dialect === 'mssql' && !locked && (
                <label className="mt-1 inline-flex items-center gap-1.5 font-sans text-xs text-text-2">
                  <input
                    type="checkbox"
                    checked={isMssqlPkClustered(model, pk)}
                    disabled={!isMssqlPkClustered(model, pk) && hasOtherClustered(pk.id)}
                    title={
                      !isMssqlPkClustered(model, pk) && hasOtherClustered(pk.id)
                        ? t('insp.mssqlClusteredConflict')
                        : undefined
                    }
                    onChange={(e) =>
                      ws.act('setPrimaryKey', {
                        id: pk.id,
                        table: table.id,
                        columns: pk.columns,
                        ext: { mssql: { clustered: e.target.checked } },
                      })
                    }
                  />
                  {t('insp.mssqlClustered')}
                </label>
              )}
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
              UNIQUE{' '}
              {model.dialect === 'mssql' ? `${u.ext?.mssql?.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} ` : ''}(
              {u.columns.map(name).join(', ')})
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
            <p className="hint">{t('insp.checkHint', { dialect: uiSpec.name })}</p>
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
                  ws.act('addUnique', {
                    id: newId(),
                    table: table.id,
                    columns: picked,
                    ...(model.dialect === 'mssql' && uniqueClustered
                      ? { ext: { mssql: { clustered: true } } }
                      : {}),
                  }) && setAdding(null)
                }
              >
                {t('insp.addUnique')}
              </button>
            }
          >
            <ColumnPicker label={t('insp.pickColumns')} columns={cols} value={picked} onChange={setPicked} />
            {model.dialect === 'mssql' && (
              <div className="space-y-1">
                <label className="check text-sm">
                  <input
                    type="checkbox"
                    checked={uniqueClustered}
                    disabled={hasOtherClustered('')}
                    onChange={(e) => setUniqueClustered(e.target.checked)}
                  />
                  {t('insp.mssqlClustered')}
                </label>
                {hasOtherClustered('') && <p className="hint m-0">{t('insp.mssqlClusteredConflict')}</p>}
              </div>
            )}
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
                  {idx
                    .allRef('table')
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
          {indexes.map((x) => {
            const colList = x.elements.map((e) => (e.column ? name(e.column) : e.expr)).join(', ');
            const label =
              model.dialect === 'mysql'
                ? `${x.ext?.mysql?.indexType ?? x.method.toUpperCase()} (${colList})`
                : model.dialect === 'mssql'
                  ? `${x.ext?.mssql?.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} (${colList})${
                      x.ext?.mssql?.fillFactor !== undefined
                        ? ` · FILLFACTOR = ${x.ext.mssql.fillFactor}`
                        : ''
                    }`
                  : `${x.method} (${colList})`;
            return (
              <Row
                key={x.id}
                icon={<ListTree size={14} aria-hidden="true" />}
                name={x.name}
                deleteLabel={`${t('insp.delete')} ${x.name}`}
                onDelete={locked ? undefined : () => ws.act('dropKey', { id: x.id })}
              >
                {x.unique && 'UNIQUE '}
                {label}
              </Row>
            );
          })}
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
                onClick={() => {
                  if (model.dialect === 'mysql') {
                    const isUnique =
                      mysqlIndexType !== 'FULLTEXT' && mysqlIndexType !== 'SPATIAL' && indexUnique;
                    if (
                      ws.act('addIndex', {
                        id: newId(),
                        table: table.id,
                        elements: picked.map((column) => ({ column })),
                        unique: isUnique,
                        method: mysqlIndexType === 'HASH' ? 'hash' : 'btree',
                        ext: { mysql: { indexType: mysqlIndexType } },
                      })
                    ) {
                      setAdding(null);
                    }
                    return;
                  }
                  if (model.dialect === 'mssql') {
                    const parsedFf = parseFillFactorInput(mssqlFillFactor);
                    if (parsedFf === 'invalid') {
                      setMssqlFillFactorErr(t('insp.mssqlFillFactorErr'));
                      return;
                    }
                    const mssqlExt = {
                      ...(mssqlIndexClustered ? { clustered: true } : {}),
                      ...(parsedFf !== null ? { fillFactor: parsedFf } : {}),
                    };
                    if (
                      ws.act('addIndex', {
                        id: newId(),
                        table: table.id,
                        elements: picked.map((column) => ({ column })),
                        unique: indexUnique,
                        ...(Object.keys(mssqlExt).length > 0 ? { ext: { mssql: mssqlExt } } : {}),
                      })
                    ) {
                      setAdding(null);
                    }
                    return;
                  }
                  if (
                    ws.act('addIndex', {
                      id: newId(),
                      table: table.id,
                      elements: picked.map((column) => ({ column })),
                      unique: indexUnique,
                    })
                  ) {
                    setAdding(null);
                  }
                }}
              >
                {t('insp.addIndex')}
              </button>
            }
          >
            <ColumnPicker label={t('insp.pickColumns')} columns={cols} value={picked} onChange={setPicked} />
            {model.dialect === 'mysql' && (
              <label className="field">
                <span className="label">{t('insp.mysqlIndexType')}</span>
                <select
                  aria-label={t('insp.mysqlIndexType')}
                  className="select font-mono"
                  value={mysqlIndexType}
                  onChange={(e) => {
                    const next = e.target.value as MysqlIndexType;
                    setMysqlIndexType(next);
                    if (next === 'FULLTEXT' || next === 'SPATIAL') setIndexUnique(false);
                  }}
                >
                  {MYSQL_INDEX_TYPES.map((it) => (
                    <option key={it} value={it}>
                      {it}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="check text-sm">
              <input
                type="checkbox"
                checked={indexUnique}
                disabled={
                  model.dialect === 'mysql' && (mysqlIndexType === 'FULLTEXT' || mysqlIndexType === 'SPATIAL')
                }
                onChange={(e) => setIndexUnique(e.target.checked)}
              />
              {t('insp.unique')}
            </label>
            {model.dialect === 'mssql' && (
              <div className="space-y-2">
                <div className="space-y-1">
                  <label className="check text-sm">
                    <input
                      type="checkbox"
                      checked={mssqlIndexClustered}
                      disabled={hasOtherClustered('')}
                      onChange={(e) => setMssqlIndexClustered(e.target.checked)}
                    />
                    {t('insp.mssqlClustered')}
                  </label>
                  {hasOtherClustered('') && <p className="hint m-0">{t('insp.mssqlClusteredConflict')}</p>}
                </div>
                <label className="field">
                  <span className="label">{t('insp.mssqlFillFactor')}</span>
                  <input
                    aria-label={t('insp.mssqlFillFactor')}
                    aria-invalid={mssqlFillFactorErr ? true : undefined}
                    aria-describedby={mssqlFillFactorErr ? fillFactorErrId : undefined}
                    className="input font-mono"
                    placeholder="80"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={mssqlFillFactor}
                    onChange={(e) => {
                      setMssqlFillFactor(e.target.value);
                      if (mssqlFillFactorErr) setMssqlFillFactorErr(null);
                    }}
                    onBlur={() => {
                      const parsed = parseFillFactorInput(mssqlFillFactor);
                      setMssqlFillFactorErr(parsed === 'invalid' ? t('insp.mssqlFillFactorErr') : null);
                    }}
                  />
                  {mssqlFillFactorErr && (
                    <p id={fillFactorErrId} className="hint error m-0">
                      {mssqlFillFactorErr}
                    </p>
                  )}
                </label>
              </div>
            )}
          </AddForm>
        )}
      </Section>

      {dialectSpec.capabilities.partitioning && (!isChild || table.partitionBy !== null) && (
        <Section
          title={t('part.section')}
          count={table.partitionBy ? children.length : undefined}
          action={
            !isChild &&
            !strategyLocked &&
            !activeEditingStrategy &&
            !table.partitionBy && (
              <button type="button" className="btn ghost sm" onClick={openStrategyEditor}>
                {t('part.configure')}
              </button>
            )
          }
        >
          {!isChild && !table.partitionBy && !activeEditingStrategy && (
            <p className="hint">
              {publishedUnknown && !locked
                ? t('part.publishedChecking')
                : isPublished
                  ? t('part.publishedHint')
                  : t('part.notPartitioned')}
            </p>
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
                {!isChild && !strategyLocked && (
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
              {!isChild && publishedUnknown && !locked && (
                <p className="hint">{t('part.publishedChecking')}</p>
              )}
              {!isChild && isPublished && <p className="hint">{t('part.publishedHint')}</p>}
              {!isChild && pgBlocksPartitionIdentity && identityCols.length > 0 && (
                <Banner kind="warn">
                  {t('part.identityRequiresPg17Banner', {
                    target: project.targetPgMajor,
                    columns: identityCols.map((c) => c.name).join(', '),
                  })}
                </Banner>
              )}
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
              {pgBlocksPartitionIdentity && identityCols.length > 0 && (
                <Banner kind="warn">
                  {t('part.identityRequiresPg17Banner', {
                    target: project.targetPgMajor,
                    columns: identityCols.map((c) => c.name).join(', '),
                  })}
                </Banner>
              )}
              <label className="field">
                <span className="label">{t('part.strategy')}</span>
                <select
                  name="partitionStrategy"
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
                        name={`partitionKeyMode_${idx}`}
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
                          name={`partitionKeyCol_${idx}`}
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
                {!locked && !isChild && spec && (
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
                              {!isChild && spec && !isSubPart && (
                                <IconButton
                                  label={t('part.editBoundLabel', { name: ch.name })}
                                  size="sm"
                                  onClick={() => openEditBound(ch, spec)}
                                >
                                  <Pencil size={13} aria-hidden="true" />
                                </IconButton>
                              )}
                              {!isChild && !isSubPart && (
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

                        {!isChild && activeEditingBoundId === ch.id && spec && (
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
                          name="attachPartitionTable"
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

      {!isChild && sections && sections.length > 0 && onSetSections && (
        <Section title={t('sec.tableSection')}>
          <select
            aria-label={t('sec.tableSection')}
            className="select"
            disabled={locked}
            value={sections.find((s) => s.tables.includes(table.id))?.id ?? ''}
            onChange={(e) => {
              const targetId = e.target.value;
              onSetSections(
                sections.map((s) => ({
                  ...s,
                  tables:
                    s.id === targetId
                      ? [...s.tables.filter((x) => x !== table.id), table.id]
                      : s.tables.filter((x) => x !== table.id),
                })),
              );
            }}
          >
            <option value="">{t('sec.unassigned')}</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Section>
      )}
    </fieldset>
  );
};

const KIND_ICON = { table: Table2, enum: List, sequence: Hash } as const;

const InspectorContent = ({
  o,
  onSelect,
  sections,
  onSetSections,
  onOpenSectionManager,
  focusedTableId,
  onFocusTable,
  onExitFocus,
  ...ctx
}: Ctx & {
  o: NonNullable<Model['objects'][string]>;
  onSelect: (id: string | null) => void;
  sections?: CanvasSection[];
  onSetSections?: (next: CanvasSection[]) => void;
  onOpenSectionManager?: () => void;
  focusedTableId?: string | null;
  onFocusTable?: (tableId: string) => void;
  onExitFocus?: () => void;
}) => {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const { ws, readOnly, model } = ctx;
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
  const canDeleteSequence = o.kind === 'sequence' && !readOnly && !o.ownedBy;
  const focusTargetId = o.kind === 'table' ? (resolveTopLevelTableId(model, o.id) ?? o.id) : null;
  const isFocusedTable = focusTargetId !== null && focusedTableId === focusTargetId;

  return (
    <>
      <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border pr-2.5 pl-3.5">
        <Icon size={16} aria-hidden="true" className="text-text-3" />
        <h2 className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-lg)] font-semibold">
          {schema &&
            (getDialect(model.dialect).capabilities.schemas ||
              schema !== getDialect(model.dialect).capabilities.defaultSchema) && (
              <span className="font-normal text-text-3">{schema}.</span>
            )}
          {o.name}
        </h2>
        {o.kind === 'opaque' && <span className="badge">{o.objType}</span>}
        {o.kind === 'table' && focusTargetId && (onFocusTable || onExitFocus) && (
          <IconButton
            label={t('sec.focusAction')}
            aria-pressed={isFocusedTable}
            onClick={() => (isFocusedTable ? onExitFocus?.() : onFocusTable?.(focusTargetId))}
          >
            <Focus
              size={16}
              aria-hidden="true"
              className={isFocusedTable ? 'text-primary-text' : undefined}
            />
          </IconButton>
        )}
        {(canDelete || canDeleteSequence) && (
          <Menu
            label={t('insp.more')}
            trigger={<Ellipsis size={16} aria-hidden="true" />}
            items={[
              ...(o.kind === 'table' && onOpenSectionManager
                ? [
                    {
                      label: t('sec.manage'),
                      icon: <Layers size={16} aria-hidden="true" />,
                      onSelect: onOpenSectionManager,
                    },
                  ]
                : []),
              canDelete
                ? {
                    label: t('insp.deleteTable'),
                    icon: <Trash2 size={16} aria-hidden="true" />,
                    danger: true,
                    separatorBefore: o.kind === 'table' && Boolean(onOpenSectionManager),
                    onSelect: () => setConfirm(true),
                  }
                : {
                    label: t('insp.deleteSequence'),
                    icon: <Trash2 size={16} aria-hidden="true" />,
                    danger: true,
                    onSelect: () => {
                      if (ws.act('dropSequence', { id: o.id })) onSelect(null);
                    },
                  },
            ]}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3.5 pt-3 pb-5">
        {o.kind === 'table' && (
          <TableInspector
            table={o}
            onSelect={onSelect}
            sections={sections}
            onSetSections={onSetSections}
            {...ctx}
          />
        )}
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
          <fieldset disabled={readOnly} className="min-w-0 space-y-3 border-0 p-0">
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
            <Section title={t('insp.sequenceOptions')}>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-sm border border-border bg-surface px-2.5 py-2 text-xs">
                <dt className="text-text-2">{t('insp.sequenceType')}</dt>
                <dd className="m-0 font-mono">{o.options.type}</dd>
                <dt className="text-text-2">{t('insp.sequenceIncrement')}</dt>
                <dd className="m-0 font-mono">{o.options.increment}</dd>
                {o.options.start !== null && (
                  <>
                    <dt className="text-text-2">{t('insp.sequenceStart')}</dt>
                    <dd className="m-0 font-mono">{o.options.start}</dd>
                  </>
                )}
                <dt className="text-text-2">{t('insp.sequenceCache')}</dt>
                <dd className="m-0 font-mono">{o.options.cache}</dd>
                <dt className="text-text-2">{t('insp.sequenceCycle')}</dt>
                <dd className="m-0 font-mono">{String(o.options.cycle)}</dd>
                {o.ownedBy && model.objects[o.ownedBy] && (
                  <>
                    <dt className="text-text-2">{t('insp.sequenceOwnedBy')}</dt>
                    <dd className="m-0 font-mono">{model.objects[o.ownedBy]!.name}</dd>
                  </>
                )}
              </dl>
            </Section>
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
      {o.kind === 'table' && confirm && !readOnly && (
        <Modal
          open
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

export const Inspector = memo(
  ({
    selected,
    onSelect,
    sections,
    onSetSections,
    onOpenSectionManager,
    focusedTableId,
    onFocusTable,
    onExitFocus,
    ...ctx
  }: Ctx & {
    selected: string | null;
    onSelect: (id: string | null) => void;
    sections?: CanvasSection[];
    onSetSections?: (next: CanvasSection[]) => void;
    onOpenSectionManager?: () => void;
    focusedTableId?: string | null;
    onFocusTable?: (tableId: string) => void;
    onExitFocus?: () => void;
  }) => {
    const { t } = useTranslation();
    const { readOnly, model } = ctx;
    const effectiveIndex = useMemo(() => ctx.modelIndex ?? buildModelIndex(model), [model, ctx.modelIndex]);

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

    // 通过对象 ID 与只读状态联合 key 挂载内容，实时降级只读时自动彻底重置全部内联表单与确认弹窗状态
    return (
      <InspectorContent
        key={`${o.id}:${readOnly ? 'ro' : 'rw'}`}
        o={o}
        onSelect={onSelect}
        sections={sections}
        onSetSections={onSetSections}
        onOpenSectionManager={onOpenSectionManager}
        focusedTableId={focusedTableId}
        onFocusTable={onFocusTable}
        onExitFocus={onExitFocus}
        {...ctx}
        modelIndex={effectiveIndex}
      />
    );
  },
);
