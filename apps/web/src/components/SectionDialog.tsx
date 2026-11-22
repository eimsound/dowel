// 画布板块（Section）管理与按表名前缀生成建议对话框（纯布局层，绝不修改 IR）。
import {
  type CanvasSection,
  MAX_SECTION_NAME_LENGTH,
  SECTION_COLORS,
  type SectionColor,
  sanitizeSections,
  sectionColorCssVar,
} from '@dowel/api';
import { all, type Model, newId, type Table } from '@dowel/core';
import { Check, Layers, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { defaultSchemaOf } from '../dialects.ts';
import { suggestSectionsByPrefix } from '../sections.ts';
import { Modal } from './Modal.tsx';
import { Banner, cx, Empty } from './ui.tsx';

interface DraftSuggestion {
  key: string;
  id: string;
  name: string;
  color: SectionColor;
  tables: string[];
  enabled: boolean;
}

const buildDrafts = (model: Model, sections: CanvasSection[]): DraftSuggestion[] =>
  suggestSectionsByPrefix(model, sections).map((s, idx) => ({
    key: `${s.id}-${idx}`,
    id: s.id,
    name: s.name,
    color: s.color,
    tables: s.tables,
    enabled: true,
  }));

export const SectionDialog = ({
  open,
  initialMode,
  onClose,
  model,
  sections,
  readOnly,
  onSaveSections,
}: {
  open: boolean;
  initialMode: 'manage' | 'suggest';
  onClose: () => void;
  model: Model;
  sections: CanvasSection[];
  readOnly: boolean;
  onSaveSections: (next: CanvasSection[]) => void;
}) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'manage' | 'suggest'>(initialMode);
  const [selectedId, setSelectedId] = useState<string | null>(sections[0]?.id ?? null);
  const [newName, setNewName] = useState('');
  const [nameDraft, setNameDraft] = useState(sections[0]?.name ?? '');
  const [tableFilter, setTableFilter] = useState('');
  const [drafts, setDrafts] = useState<DraftSuggestion[]>([]);

  const [prevOpen, setPrevOpen] = useState(open);
  const [prevInitialMode, setPrevInitialMode] = useState(initialMode);
  if (open !== prevOpen || (open && initialMode !== prevInitialMode)) {
    setPrevOpen(open);
    setPrevInitialMode(initialMode);
    if (open) {
      const nextMode = readOnly ? 'manage' : initialMode;
      setMode(nextMode);
      const first = sections[0] ?? null;
      setSelectedId(first?.id ?? null);
      setNameDraft(first?.name ?? '');
      setNewName('');
      setTableFilter('');
      setDrafts(nextMode === 'suggest' ? buildDrafts(model, sections) : []);
    }
  }

  const activeSection = useMemo(
    () => sections.find((s) => s.id === selectedId) ?? sections[0] ?? null,
    [sections, selectedId],
  );

  const [prevActiveKey, setPrevActiveKey] = useState<string>('');
  const activeKey = activeSection ? `${activeSection.id}:${activeSection.name}` : '';
  if (activeKey !== prevActiveKey) {
    setPrevActiveKey(activeKey);
    setNameDraft(activeSection?.name ?? '');
  }

  const nameInputId = useId();
  const colorLabelId = useId();

  const defaultSchema = defaultSchemaOf(model);
  const topTables = useMemo(
    () =>
      all(model, 'table')
        .filter((tb) => !tb.partitionOf)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    [model],
  );

  const tableLabel = useCallback(
    (tb: Table) => {
      const schemaName = model.objects[tb.parent]?.name ?? '';
      return schemaName && schemaName !== defaultSchema ? `${schemaName}.${tb.name}` : tb.name;
    },
    [defaultSchema, model.objects],
  );

  const tableNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const tb of topTables) map.set(tb.id, tableLabel(tb));
    return map;
  }, [topTables, tableLabel]);

  const ownerByTable = useMemo(() => {
    const map = new Map<string, CanvasSection>();
    for (const s of sections) {
      for (const tid of s.tables) map.set(tid, s);
    }
    return map;
  }, [sections]);

  const filteredTables = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    if (!q) return topTables;
    return topTables.filter((tb) => tableLabel(tb).toLowerCase().includes(q));
  }, [topTables, tableFilter, tableLabel]);

  const commitSections = (next: CanvasSection[]) => {
    if (readOnly) return;
    onSaveSections(sanitizeSections(next));
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    const trimmed = newName.trim().slice(0, MAX_SECTION_NAME_LENGTH).trim();
    if (!trimmed) return;
    const id = `sec-${newId()}`;
    const color = SECTION_COLORS[sections.length % SECTION_COLORS.length]!;
    const next = sanitizeSections([...sections, { id, name: trimmed, color, tables: [] }]);
    onSaveSections(next);
    setNewName('');
    setSelectedId(id);
    setNameDraft(trimmed);
  };

  const handleRename = (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || !activeSection) return;
    const trimmed = nameDraft.trim().slice(0, MAX_SECTION_NAME_LENGTH).trim();
    if (!trimmed || trimmed === activeSection.name) return;
    commitSections(sections.map((s) => (s.id === activeSection.id ? { ...s, name: trimmed } : s)));
  };

  const handleRecolor = (color: SectionColor) => {
    if (readOnly || !activeSection || activeSection.color === color) return;
    commitSections(sections.map((s) => (s.id === activeSection.id ? { ...s, color } : s)));
  };

  const handleDelete = () => {
    if (readOnly || !activeSection) return;
    const remaining = sections.filter((s) => s.id !== activeSection.id);
    commitSections(remaining);
    const nextSel = remaining[0] ?? null;
    setSelectedId(nextSel?.id ?? null);
    setNameDraft(nextSel?.name ?? '');
  };

  const handleToggleTable = (tableId: string, checked: boolean) => {
    if (readOnly || !activeSection) return;
    const next = sections.map((s) => {
      if (s.id === activeSection.id) {
        const tables = checked
          ? [...s.tables.filter((x) => x !== tableId), tableId]
          : s.tables.filter((x) => x !== tableId);
        return { ...s, tables };
      }
      return checked ? { ...s, tables: s.tables.filter((x) => x !== tableId) } : s;
    });
    commitSections(next);
  };

  const openSuggest = () => {
    if (readOnly) return;
    setDrafts(buildDrafts(model, sections));
    setMode('suggest');
  };

  const enabledDrafts = drafts.filter((d) => d.enabled && d.name.trim().length > 0 && d.tables.length > 0);

  const applySuggestions = () => {
    if (readOnly || enabledDrafts.length === 0) return;
    const added: CanvasSection[] = enabledDrafts.map((d) => ({
      id: d.id,
      name: d.name.trim().slice(0, MAX_SECTION_NAME_LENGTH).trim(),
      color: d.color,
      tables: d.tables,
    }));
    const merged = sanitizeSections([...sections, ...added]);
    onSaveSections(merged);
    setSelectedId(added[0]?.id ?? null);
    setMode('manage');
  };

  const activeMode = readOnly ? 'manage' : mode;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      icon={
        activeMode === 'suggest' ? (
          <Sparkles size={16} aria-hidden="true" />
        ) : (
          <Layers size={16} aria-hidden="true" />
        )
      }
      title={activeMode === 'suggest' ? t('sec.suggestTitle') : t('sec.manageTitle')}
      footer={
        activeMode === 'suggest' ? (
          <>
            <button type="button" className="btn" onClick={() => setMode('manage')}>
              {t('sec.back')}
            </button>
            <span className="flex-1" />
            <button type="button" className="btn" onClick={onClose}>
              {t('dlg.close')}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={readOnly || enabledDrafts.length === 0}
              onClick={applySuggestions}
            >
              {t('sec.applySuggestions')}
            </button>
          </>
        ) : (
          <>
            <span className="flex-1" />
            <button type="button" className="btn" onClick={onClose}>
              {t('dlg.close')}
            </button>
          </>
        )
      }
    >
      {activeMode === 'manage' ? (
        <div className="space-y-3">
          {readOnly && <Banner kind="info">{t('sec.readonlyHint')}</Banner>}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
            {/* 左侧：新建与板块列表 */}
            <div className="flex min-h-[360px] flex-col gap-2.5 border-border md:border-r md:pr-4">
              <form onSubmit={handleCreate} className="flex gap-1.5">
                <input
                  type="text"
                  aria-label={t('sec.newNameLabel')}
                  placeholder={t('sec.newNamePlaceholder')}
                  maxLength={MAX_SECTION_NAME_LENGTH}
                  disabled={readOnly}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="input min-w-0 flex-1"
                />
                <button type="submit" className="btn shrink-0" disabled={readOnly || !newName.trim()}>
                  <Plus size={14} aria-hidden="true" />
                  {t('sec.createSection')}
                </button>
              </form>

              <button
                type="button"
                className="btn w-full justify-start"
                disabled={readOnly}
                onClick={openSuggest}
              >
                <Sparkles size={14} aria-hidden="true" className="text-text-3" />
                {t('sec.suggestByPrefix')}
              </button>

              {sections.length === 0 ? (
                <div className="pt-2">
                  <Empty
                    icon={<Layers size={28} strokeWidth={1.5} aria-hidden="true" />}
                    title={t('sec.noSectionsTitle')}
                  >
                    {t('sec.noSectionsBody')}
                  </Empty>
                </div>
              ) : (
                <nav aria-label={t('sec.sectionListLabel')} className="min-h-0 flex-1 overflow-auto">
                  <ul className="m-0 list-none space-y-1 p-0">
                    {sections.map((s) => {
                      const active = activeSection?.id === s.id;
                      return (
                        <li key={s.id}>
                          <button
                            type="button"
                            aria-current={active ? 'true' : undefined}
                            onClick={() => {
                              setSelectedId(s.id);
                              setNameDraft(s.name);
                            }}
                            className={cx(
                              'flex h-[var(--row-h)] w-full items-center gap-2 rounded-sm px-2 text-left text-sm transition-colors',
                              active
                                ? 'bg-primary-soft font-medium text-primary-text'
                                : 'text-text-2 hover:bg-surface-hover',
                            )}
                          >
                            <span
                              aria-hidden="true"
                              className="size-2.5 shrink-0 rounded-full"
                              style={{ background: sectionColorCssVar(s.color) }}
                            />
                            <span className="min-w-0 flex-1 truncate">{s.name}</span>
                            <span className="count">{s.tables.length}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </nav>
              )}
            </div>

            {/* 右侧：当前选中板块编辑 */}
            <div className="flex min-h-[360px] min-w-0 flex-col gap-3.5">
              {!activeSection ? (
                <div className="flex flex-1 items-center justify-center text-sm text-text-3">
                  {t('sec.selectSectionHint')}
                </div>
              ) : (
                <>
                  <form onSubmit={handleRename} className="field">
                    <label htmlFor={nameInputId} className="label">
                      {t('sec.nameLabel')}
                    </label>
                    <div className="flex gap-2">
                      <input
                        id={nameInputId}
                        type="text"
                        maxLength={MAX_SECTION_NAME_LENGTH}
                        disabled={readOnly}
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        className="input min-w-0 flex-1"
                      />
                      <button
                        type="submit"
                        className="btn shrink-0"
                        disabled={readOnly || !nameDraft.trim() || nameDraft.trim() === activeSection.name}
                      >
                        {t('sec.saveName')}
                      </button>
                    </div>
                  </form>

                  <div className="field">
                    <span id={colorLabelId} className="label">
                      {t('sec.colorLabel')}
                    </span>
                    <div role="group" aria-labelledby={colorLabelId} className="flex flex-wrap gap-1.5">
                      {SECTION_COLORS.map((c, idx) => {
                        const pressed = activeSection.color === c;
                        return (
                          <button
                            key={c}
                            type="button"
                            aria-label={t('sec.colorOption', { n: idx + 1 })}
                            aria-pressed={pressed}
                            disabled={readOnly}
                            onClick={() => handleRecolor(c)}
                            className={cx(
                              'flex size-7 items-center justify-center rounded-sm border transition-colors',
                              pressed
                                ? 'border-primary bg-surface-active ring-2 ring-[var(--primary-ring)]'
                                : 'border-border-strong bg-surface hover:bg-surface-hover',
                              readOnly && 'cursor-not-allowed opacity-45',
                            )}
                          >
                            <span
                              aria-hidden="true"
                              className="flex size-4 items-center justify-center rounded-full text-white"
                              style={{ background: sectionColorCssVar(c) }}
                            >
                              {pressed && <Check size={11} strokeWidth={2.5} aria-hidden="true" />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex min-h-0 flex-1 flex-col gap-2 border-t border-border pt-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="label">{t('sec.tablesLabel')}</span>
                      <span className="count">{activeSection.tables.length}</span>
                    </div>
                    <label className="flex h-[var(--ctl-h)] items-center gap-1.5 rounded-sm border border-border-strong bg-surface px-2 text-text-3 focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--primary-ring)]">
                      <Search size={14} aria-hidden="true" />
                      <input
                        type="search"
                        aria-label={t('sec.searchTables')}
                        placeholder={t('sec.searchTables')}
                        value={tableFilter}
                        onChange={(e) => setTableFilter(e.target.value)}
                        className="min-w-0 flex-1 border-0 bg-transparent text-sm text-text outline-0"
                      />
                    </label>
                    <div className="max-h-[220px] min-h-0 flex-1 overflow-auto rounded-sm border border-border bg-surface p-1">
                      {filteredTables.length === 0 ? (
                        <p className="px-2 py-4 text-center text-xs text-text-3">{t('ws.noMatch')}</p>
                      ) : (
                        filteredTables.map((tb) => {
                          const owner = ownerByTable.get(tb.id);
                          const checked = owner?.id === activeSection.id;
                          const other = owner && owner.id !== activeSection.id ? owner : null;
                          return (
                            <label
                              key={tb.id}
                              className="flex min-h-[28px] cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-surface-hover"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={readOnly}
                                onChange={(e) => handleToggleTable(tb.id, e.target.checked)}
                              />
                              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                                {tableLabel(tb)}
                              </span>
                              {other && (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-xs bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-3">
                                  <span
                                    aria-hidden="true"
                                    className="size-1.5 rounded-full"
                                    style={{ background: sectionColorCssVar(other.color) }}
                                  />
                                  {t('sec.inOtherSection', { name: other.name })}
                                </span>
                              )}
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                    <span className="text-xs text-text-3">{t('sec.deleteHint')}</span>
                    <button type="button" className="btn danger" disabled={readOnly} onClick={handleDelete}>
                      <Trash2 size={14} aria-hidden="true" />
                      {t('sec.deleteSection')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="m-0 text-sm text-text-2">{t('sec.suggestHint')}</p>
            {drafts.length > 0 && (
              <span className="count">{t('sec.suggestedCount', { count: enabledDrafts.length })}</span>
            )}
          </div>
          {drafts.length === 0 ? (
            <Banner kind="info">{t('sec.noSuggestions')}</Banner>
          ) : (
            <div className="space-y-2.5">
              {drafts.map((d) => (
                <div key={d.key} className="space-y-2 rounded-md border border-border bg-surface p-3">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <label className="check shrink-0">
                      <input
                        type="checkbox"
                        aria-label={d.name}
                        checked={d.enabled}
                        onChange={(e) =>
                          setDrafts((prev) =>
                            prev.map((x) => (x.key === d.key ? { ...x, enabled: e.target.checked } : x)),
                          )
                        }
                      />
                    </label>
                    <input
                      type="text"
                      aria-label={t('sec.nameLabel')}
                      maxLength={MAX_SECTION_NAME_LENGTH}
                      value={d.name}
                      onChange={(e) =>
                        setDrafts((prev) =>
                          prev.map((x) => (x.key === d.key ? { ...x, name: e.target.value } : x)),
                        )
                      }
                      className="input min-w-[140px] flex-1"
                    />
                    <div className="flex items-center gap-1">
                      {SECTION_COLORS.map((c, idx) => {
                        const pressed = d.color === c;
                        return (
                          <button
                            key={c}
                            type="button"
                            aria-label={t('sec.colorOption', { n: idx + 1 })}
                            aria-pressed={pressed}
                            onClick={() =>
                              setDrafts((prev) => prev.map((x) => (x.key === d.key ? { ...x, color: c } : x)))
                            }
                            className={cx(
                              'flex size-6 items-center justify-center rounded-sm border',
                              pressed ? 'border-primary bg-surface-active' : 'border-border bg-surface-2',
                            )}
                          >
                            <span
                              aria-hidden="true"
                              className="flex size-3.5 items-center justify-center rounded-full text-white"
                              style={{ background: sectionColorCssVar(c) }}
                            >
                              {pressed && <Check size={10} strokeWidth={2.5} aria-hidden="true" />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <span className="count">{t('sec.tableCount', { count: d.tables.length })}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pl-6">
                    {d.tables.map((tid) => (
                      <span key={tid} className="badge font-mono">
                        {tableNameById.get(tid) ?? tid}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};
