// 属性面板（DESIGN.md：属性面板）：编辑选中的表、枚举、序列；不透明对象只读显示 DDL。
// 输入框是“草稿”：获得焦点时记下所依据对象的版本，保存时一并提交——期间别人改过这些对象，保存会被拒绝（04-ir-design.md 2.3）。
import {
  all,
  COMMON_TYPES,
  type Column,
  childrenOf,
  columnsOf,
  type FkAction,
  type Model,
  newId,
  normalizeType,
  type Table,
} from '@dowel/core';
import type { Versions } from '@dowel/sync';
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
  Link2,
  List,
  ListTree,
  MousePointerClick,
  Plus,
  Table2,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
      <span className="ml-auto">{action}</span>
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

const TableInspector = ({ table, ws, model, readOnly }: Ctx & { table: Table }) => {
  const { t } = useTranslation();
  const cols = columnsOf(model, table.id);
  const pk = childrenOf(model, table.id, 'primaryKey')[0];
  const checks = childrenOf(model, table.id, 'check');
  const uniques = childrenOf(model, table.id, 'unique');
  const fks = childrenOf(model, table.id, 'foreignKey');
  const indexes = childrenOf(model, table.id, 'index');
  const tableIds = [table.id, ...cols.map((c) => c.id)];
  const name = (id: string) => model.objects[id]?.name ?? '?';
  const locked = readOnly || !!table.partitionBy || !!table.partitionOf;
  const fkCols = new Set(fks.flatMap((f) => f.columns));
  const [openCol, setOpenCol] = useState<string | null>(null);
  const [focusNew, setFocusNew] = useState<string | null>(null);
  const [adding, setAdding] = useState<'check' | 'unique' | 'fk' | 'index' | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [indexUnique, setIndexUnique] = useState(false);
  const emptyFk = { col: '', ref: '', refCol: '', onDelete: 'noAction' as FkAction };
  const [fk, setFk] = useState(emptyFk);
  const typesId = useId();

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

  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3 border-0 p-0">
      {(table.partitionBy || table.partitionOf) && <Banner kind="warn">{t('insp.partitioned')}</Banner>}
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

      <Section
        title={t('insp.columns')}
        count={cols.length}
        action={
          !locked && (
            <IconButton label={t('insp.addColumn')} size="sm" onClick={addColumn}>
              <Plus size={14} aria-hidden="true" />
            </IconButton>
          )
        }
      >
        <datalist id={typesId}>
          {[...COMMON_TYPES, ...all(model, 'enum').map((e) => e.name)].map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <ul className="list-none overflow-hidden rounded-sm border border-border bg-surface p-0">
          {cols.map((c, i) => {
            const open = openCol === c.id;
            const isPk = !!pk?.columns.includes(c.id);
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
                  <span className="flex w-[52px] justify-end gap-[3px]">
                    {isPk && <b className="flag pk">PK</b>}
                    {fkCols.has(c.id) && <b className="flag fk">FK</b>}
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
                          onCommit={(v, b) =>
                            ws.act('setColumnType', { id: c.id, ...parseType(model, v) }, b)
                          }
                        />
                      </Labeled>
                    </div>
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
                        label={`${t('insp.delete')} ${c.name}`}
                        size="sm"
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
        {!pk && !fks.length && !uniques.length && !checks.length && adding === null && (
          <p className="hint">{t('insp.noConstraints')}</p>
        )}
        {adding === 'check' && (
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
        {adding === 'unique' && (
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
        {adding === 'fk' && (
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
        {!indexes.length && adding !== 'index' && <p className="hint">{t('insp.noIndexes')}</p>}
        {adding === 'index' && (
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
  const o = selected ? ctx.model.objects[selected] : undefined;
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
  const { ws, readOnly, model } = ctx;
  const schema = 'parent' in o ? model.objects[o.parent]?.name : undefined;
  const Icon =
    o.kind === 'opaque'
      ? o.objType.includes('iew')
        ? Eye
        : FileCode
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
        {o.kind === 'table' && <TableInspector key={o.id} table={o} {...ctx} />}
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
          open={confirm}
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
