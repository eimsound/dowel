// 画布修改历史（C4）：对标在线文档的修改历史体验。
// 左侧时间线（支持分页加载与版本徽章），右侧三维度预览（本次修改 / 当时状态 / 与当前画布的差异），
// 以及带二次确认与并发冲突处理的“恢复到此状态”。
import type {
  CanvasHistoryConflict,
  CanvasHistoryDetail,
  CanvasHistoryEntry,
  CanvasHistoryList,
  ModelUpdate,
} from '@dowel/api';
import {
  all,
  ClipboardError,
  type ClipboardPayload,
  childrenOf,
  columnsOf,
  copyItems,
  copyTables,
  createAll,
  formatScript,
  type Model,
} from '@dowel/core';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  FileCode,
  GitCompareArrows,
  History,
  List,
  LoaderCircle,
  RotateCcw,
  Table2,
  Tag,
  Workflow,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from '../api.ts';
import { writeClipboard } from '../clipboard.ts';
import { defaultSchemaOf } from '../dialects.ts';
import { formatTime } from '../format.ts';
import { useProject } from '../project.tsx';
import type { Layout } from '../workspace.ts';
import { Canvas, shortType, typeLabel } from './Canvas.tsx';
import { DiffList } from './ExecDialog.tsx';
import { Modal } from './Modal.tsx';
import { SqlView } from './SqlView.tsx';
import { useToast } from './Toasts.tsx';
import { Banner, cx, Empty, IconButton } from './ui.tsx';

type PreviewTab = 'opDiff' | 'state' | 'diffToCurrent';

/** 从历史快照复制：表 / 表内项（结果显示在对话框内，不弹通知） */
interface HistoryCopy {
  tables: (ids: string[]) => void;
  items: (tableId: string, itemIds: string[]) => void;
}
type StateView = 'canvas' | 'schema' | 'sql';

const outside = (e: PointerEvent, d: HTMLDialogElement) => {
  const r = d.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};

const parseWorkingChangedConflict = (e: unknown): CanvasHistoryConflict | null => {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const body = e.body as Partial<CanvasHistoryConflict> | undefined;
  if (body?.code !== 'working_changed' || typeof body.currentSeq !== 'number' || !body.diffToCurrent) {
    return null;
  }
  return {
    error: body.error ?? e.message,
    code: 'working_changed',
    currentSeq: body.currentSeq,
    diffToCurrent: body.diffToCurrent,
  };
};

/** 历史画布只读预览：使用独立本地布局，不改动工作区协作布局 */
const HistoryCanvasPreview = ({
  model,
  seedLayout,
  copy,
}: {
  model: Model;
  seedLayout: Layout;
  copy?: HistoryCopy;
}) => {
  const { t } = useTranslation();
  const [localLayout, setLocalLayout] = useState<Layout>(() => ({ ...seedLayout }));
  const [selected, setSelected] = useState<string | null>(null);
  const [multi, setMulti] = useState<string[]>([]);
  const select = useCallback((id: string | null) => {
    setSelected(id);
    setMulti([]);
  }, []);
  const toggle = useCallback(
    (id: string) => {
      const base = multi.length ? multi : selected ? [selected] : [];
      const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
      setMulti(next.length > 1 ? next : []);
      setSelected(next.includes(id) ? id : (next.at(-1) ?? null));
    },
    [multi, selected],
  );
  const selectMany = useCallback((ids: string[]) => {
    setMulti(ids.length > 1 ? ids : []);
    setSelected(ids[0] ?? null);
  }, []);
  const picked = multi.length ? multi : selected ? [selected] : [];
  const tables = useMemo(() => all(model, 'table').filter((tb) => !tb.partitionOf), [model]);
  const onMove = useCallback((patch: Layout) => {
    setLocalLayout((prev) => ({ ...prev, ...patch }));
  }, []);

  if (!tables.length) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty icon={<Table2 size={28} aria-hidden="true" />} title={t('hist.emptyCanvasTitle')}>
          {t('hist.emptyCanvasBody')}
        </Empty>
      </div>
    );
  }
  return (
    <div className="relative h-full min-h-[320px] w-full bg-[var(--canvas)]">
      <Canvas
        model={model}
        layout={localLayout}
        selected={selected}
        onSelect={select}
        onMove={onMove}
        relayout={0}
        multi={multi}
        onToggleSelect={toggle}
        onSelectMany={selectMany}
      />
      {copy && (
        <div className="absolute top-2 left-2 z-10 flex items-center gap-2 rounded-sm border border-border bg-surface px-2 py-1 text-xs text-text-2 shadow-[var(--shadow-sm)]">
          <span>
            {picked.length ? t('clip.selectedTables', { count: picked.length }) : t('hist.copyHint')}
          </span>
          <button
            type="button"
            className="btn sm"
            disabled={!picked.length}
            onClick={() => copy.tables(picked)}
          >
            <Copy size={14} aria-hidden="true" />
            {t('clip.copySelectedTables')}
          </button>
        </div>
      )}
    </div>
  );
};

/** 当时状态的只读表结构总览（兼顾键盘与屏幕阅读器快速浏览） */
const HistorySchemaSummary = ({ model, copy }: { model: Model; copy?: HistoryCopy }) => {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string[]>([]);
  const tables = useMemo(
    () =>
      all(model, 'table')
        .filter((tb) => !tb.partitionOf)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [model],
  );
  const enums = useMemo(() => all(model, 'enum').sort((a, b) => a.name.localeCompare(b.name)), [model]);
  const sequences = useMemo(
    () => all(model, 'sequence').sort((a, b) => a.name.localeCompare(b.name)),
    [model],
  );
  const opaques = useMemo(() => all(model, 'opaque').sort((a, b) => a.name.localeCompare(b.name)), [model]);

  const pkCols = useMemo(() => new Set(all(model, 'primaryKey').flatMap((p) => p.columns)), [model]);
  const fkCols = useMemo(() => new Set(all(model, 'foreignKey').flatMap((f) => f.columns)), [model]);
  const uqCols = useMemo(
    () =>
      new Set(
        all(model, 'unique')
          .filter((u) => u.columns.length === 1)
          .flatMap((u) => u.columns),
      ),
    [model],
  );

  if (!tables.length && !enums.length && !sequences.length && !opaques.length) {
    return (
      <div className="p-6">
        <Empty icon={<Table2 size={28} aria-hidden="true" />} title={t('hist.emptyCanvasTitle')}>
          {t('hist.emptyCanvasBody')}
        </Empty>
      </div>
    );
  }

  const defSchema = defaultSchemaOf(model);
  const schemaPrefix = (parentId: string) => {
    const s = model.objects[parentId]?.name;
    return s && s !== defSchema ? `${s}.` : '';
  };

  const keyLabel = (o: { kind: string }) =>
    o.kind === 'primaryKey'
      ? 'PK'
      : o.kind === 'unique'
        ? 'UQ'
        : o.kind === 'check'
          ? 'CK'
          : o.kind === 'foreignKey'
            ? 'FK'
            : 'IX';

  return (
    <div className="space-y-4 p-4">
      {tables.length > 0 && (
        <section className="space-y-2">
          <h3 className="section-title m-0">
            <Table2 size={14} aria-hidden="true" />
            {t('ws.tables')}
            <span className="count">{tables.length}</span>
          </h3>
          {copy && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-2">
              {picked.length > 0 && <span>{t('clip.selectedTables', { count: picked.length })}</span>}
              <button
                type="button"
                className="btn sm"
                disabled={!picked.length}
                onClick={() => copy.tables(picked)}
              >
                <Copy size={14} aria-hidden="true" />
                {t('clip.copySelectedTables')}
              </button>
              {picked.length > 0 && (
                <button type="button" className="btn ghost sm" onClick={() => setPicked([])}>
                  {t('clip.clearSelection')}
                </button>
              )}
            </div>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {tables.map((tb) => {
              const cols = columnsOf(model, tb.id);
              const keys = [
                ...childrenOf(model, tb.id, 'primaryKey'),
                ...childrenOf(model, tb.id, 'unique'),
                ...childrenOf(model, tb.id, 'check'),
                ...childrenOf(model, tb.id, 'foreignKey'),
                ...childrenOf(model, tb.id, 'index'),
              ];
              const fullName = `${schemaPrefix(tb.parent)}${tb.name}`;
              return (
                <div key={tb.id} className="overflow-hidden rounded-md border border-border bg-panel">
                  <div className="flex items-center gap-1.5 border-b border-border bg-surface-2 px-3 py-2 font-mono text-sm font-semibold">
                    {copy ? (
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          aria-label={t('clip.selectTable', { name: fullName })}
                          checked={picked.includes(tb.id)}
                          onChange={(e) =>
                            setPicked((p) =>
                              e.target.checked ? [...p, tb.id] : p.filter((x) => x !== tb.id),
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {schemaPrefix(tb.parent) && (
                            <span className="font-normal text-text-3">{schemaPrefix(tb.parent)}</span>
                          )}
                          {tb.name}
                        </span>
                      </label>
                    ) : (
                      <>
                        <Table2 size={14} aria-hidden="true" className="text-text-3" />
                        <span className="min-w-0 flex-1 truncate">
                          {schemaPrefix(tb.parent) && (
                            <span className="font-normal text-text-3">{schemaPrefix(tb.parent)}</span>
                          )}
                          {tb.name}
                        </span>
                      </>
                    )}
                    <span className="count font-sans">{cols.length}</span>
                    {copy && (
                      <IconButton
                        label={t('clip.copyTable', { name: fullName })}
                        size="sm"
                        onClick={() => copy.tables([tb.id])}
                      >
                        <Copy size={14} aria-hidden="true" />
                      </IconButton>
                    )}
                  </div>
                  <ul className="m-0 list-none divide-y divide-border p-0">
                    {cols.map((c) => {
                      const key = pkCols.has(c.id)
                        ? 'PK'
                        : fkCols.has(c.id)
                          ? 'FK'
                          : uqCols.has(c.id)
                            ? 'UQ'
                            : '';
                      const nn = c.notNull || pkCols.has(c.id);
                      return (
                        <li
                          key={c.id}
                          className="group flex items-center gap-2 px-3 py-1.5 font-mono text-xs"
                        >
                          <span
                            className={cx(
                              'w-5 shrink-0 text-[10px] font-semibold',
                              key === 'PK' ? 'text-pk' : key === 'FK' ? 'text-fk' : 'text-text-3',
                            )}
                          >
                            {key}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-text">
                            {c.name}
                            {!nn && <span className="text-text-3">?</span>}
                          </span>
                          <span className={cx('shrink-0', c.typeRef ? 'text-enum' : 'text-text-3')}>
                            {shortType(typeLabel(model, c))}
                          </span>
                          {copy && (
                            <IconButton
                              label={t('clip.copyColumn', { name: `${fullName}.${c.name}` })}
                              size="sm"
                              className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                              onClick={() => copy.items(tb.id, [c.id])}
                            >
                              <Copy size={13} aria-hidden="true" />
                            </IconButton>
                          )}
                        </li>
                      );
                    })}
                    {cols.length === 0 && (
                      <li className="px-3 py-2 text-xs text-text-3">{t('hist.noColumns')}</li>
                    )}
                  </ul>
                  {copy && keys.length > 0 && (
                    <details className="border-t border-border">
                      <summary className="cursor-pointer px-3 py-1.5 text-xs text-text-2">
                        {t('hist.keysAndIndexes', { count: keys.length })}
                        <span className="sr-only">{t('hist.keysAndIndexesOf', { name: fullName })}</span>
                      </summary>
                      <ul className="m-0 list-none divide-y divide-border p-0">
                        {keys.map((k) => (
                          <li
                            key={k.id}
                            className="group flex items-center gap-2 px-3 py-1.5 font-mono text-xs"
                          >
                            <span className="w-5 shrink-0 text-[10px] font-semibold text-text-3">
                              {keyLabel(k)}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{k.name}</span>
                            <IconButton
                              label={t('clip.copyItem', { name: `${fullName}.${k.name}` })}
                              size="sm"
                              className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                              onClick={() => copy.items(tb.id, [k.id])}
                            >
                              <Copy size={13} aria-hidden="true" />
                            </IconButton>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
      {(enums.length > 0 || sequences.length > 0 || opaques.length > 0) && (
        <section className="space-y-2">
          <h3 className="section-title m-0">{t('hist.otherObjects')}</h3>
          <ul className="m-0 list-none space-y-1.5 p-0">
            {enums.map((e) => (
              <li
                key={e.id}
                className="flex items-center gap-2 rounded-sm border border-border bg-panel px-3 py-1.5 font-mono text-xs"
              >
                <span className="badge font-sans">enum</span>
                <span>
                  {schemaPrefix(e.parent)}
                  {e.name}
                </span>
                <span className="truncate text-text-3">({e.values.join(', ')})</span>
              </li>
            ))}
            {sequences.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded-sm border border-border bg-panel px-3 py-1.5 font-mono text-xs"
              >
                <span className="badge font-sans">sequence</span>
                <span>
                  {schemaPrefix(s.parent)}
                  {s.name}
                </span>
              </li>
            ))}
            {opaques.map((o) => (
              <li
                key={o.id}
                className="flex items-center gap-2 rounded-sm border border-border bg-panel px-3 py-1.5 font-mono text-xs"
              >
                <span className="badge font-sans">{o.objType}</span>
                <span>{o.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

export const CanvasHistory = ({
  pid,
  open,
  onClose,
  readOnly,
  layout,
}: {
  pid: string;
  open: boolean;
  onClose: () => void;
  readOnly: boolean;
  layout: Layout;
}) => {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const tabBase = useId();

  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [tab, setTab] = useState<PreviewTab>('opDiff');
  const [stateView, setStateView] = useState<StateView>('canvas');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [conflict, setConflict] = useState<CanvasHistoryConflict | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const { project } = useProject();
  const [copyStatus, setCopyStatus] = useState<{ text: string; error: boolean } | null>(null);

  const confirmOpenRef = useRef(confirmOpen);
  useLayoutEffect(() => {
    confirmOpenRef.current = confirmOpen;
  });

  // 打开 / 关闭原生 <dialog>（遵循 modern-web-guidance: dialog）
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Safari 不支持 closedby="any" 时的外部点击兜底（按下与松开都在外部才关闭）
  useEffect(() => {
    const d = dialogRef.current;
    if (!d || 'closedBy' in HTMLDialogElement.prototype) return;
    let pressedOutside = false;
    const down = (e: PointerEvent) => {
      pressedOutside = !confirmOpenRef.current && outside(e, d);
    };
    const up = (e: PointerEvent) => {
      if (!confirmOpenRef.current && pressedOutside && outside(e, d)) d.close();
    };
    d.addEventListener('pointerdown', down);
    d.addEventListener('pointerup', up);
    return () => {
      d.removeEventListener('pointerdown', down);
      d.removeEventListener('pointerup', up);
    };
  }, []);

  // 每次重新打开时回到默认选中最新条目
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setSelectedSeq(null);
      setConfirmOpen(false);
      setConflict(null);
      setRestoreError(null);
    }
  }

  const listQuery = useInfiniteQuery({
    queryKey: ['canvas-history', pid],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '30' });
      if (pageParam !== undefined) qs.set('beforeSeq', String(pageParam));
      return api<CanvasHistoryList>('GET', `/api/projects/${pid}/history?${qs.toString()}`);
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBeforeSeq ?? undefined,
    enabled: open,
    refetchOnMount: 'always',
    gcTime: 0,
  });

  const entries = useMemo(() => {
    const seen = new Set<number>();
    const out: CanvasHistoryEntry[] = [];
    for (const page of listQuery.data?.pages ?? []) {
      for (const e of page.entries) {
        if (seen.has(e.seq)) continue;
        seen.add(e.seq);
        out.push(e);
      }
    }
    return out;
  }, [listQuery.data]);

  const activeSeq = selectedSeq ?? entries[0]?.seq ?? null;

  const detailQuery = useQuery({
    queryKey: ['canvas-history-detail', pid, activeSeq],
    queryFn: () => api<CanvasHistoryDetail<Model>>('GET', `/api/projects/${pid}/history/${activeSeq}`),
    enabled: open && activeSeq !== null,
    gcTime: 0,
  });

  const detail = detailQuery.data;

  const ddl = useMemo(() => {
    if (!detail || tab !== 'state' || stateView !== 'sql') return '';
    return formatScript(createAll(detail.model), detail.model.dialect);
  }, [detail, tab, stateView]);

  const tableCount = useMemo(
    () => (detail ? all(detail.model, 'table').filter((tb) => !tb.partitionOf).length : 0),
    [detail],
  );

  const restore = useMutation({
    mutationFn: ({ seq, workingSeq }: { seq: number; workingSeq: number }) =>
      api<ModelUpdate>('POST', `/api/projects/${pid}/history/${seq}/restore`, { workingSeq }),
    onMutate: () => {
      setRestoreError(null);
    },
    onSuccess: (res, vars) => {
      void qc.invalidateQueries({ queryKey: ['canvas-history', pid] });
      void qc.invalidateQueries({ queryKey: ['canvas-history-detail', pid] });
      void qc.invalidateQueries({ queryKey: ['activity', pid] });
      setConfirmOpen(false);
      setConflict(null);
      setRestoreError(null);
      toast(t('hist.restored', { seq: vars.seq, newSeq: res.seq }));
      onClose();
    },
    onError: (e) => {
      const nextConflict = parseWorkingChangedConflict(e);
      if (nextConflict) {
        setConflict(nextConflict);
        setRestoreError(null);
        void qc.invalidateQueries({ queryKey: ['canvas-history', pid] });
        void qc.invalidateQueries({ queryKey: ['canvas-history-detail', pid] });
        return;
      }
      setRestoreError(e.message || String(e));
    },
  });

  const { reset: resetRestore } = restore;

  const opText = (opName: string) => t(`hist.op.${opName}`, { defaultValue: opName });

  // 复制结果写在对话框内的状态行（对话框打开时不弹通知，DESIGN.md：反馈）
  const lastCopyText = useRef('');
  const reportCopy = useCallback(
    (build: () => ClipboardPayload) => {
      let text: string;
      let error = false;
      try {
        const p = build();
        void writeClipboard(p);
        text =
          p.kind === 'tables'
            ? t('clip.copiedInDialogTables', { count: p.tables.length })
            : t('clip.copiedInDialogItems', { count: p.items.length });
      } catch (e) {
        error = true;
        text =
          e instanceof ClipboardError && e.code === 'too_large'
            ? t('clip.tooLarge')
            : t('clip.copyFailed', { reason: e instanceof Error ? e.message : String(e) });
      }
      // 读屏对与上次完全相同的消息不再播报：重复时补一个不换行空格
      if (text === lastCopyText.current) text += '\u00A0';
      lastCopyText.current = text;
      setCopyStatus({ text, error });
    },
    [t],
  );
  const historyCopy = useMemo<HistoryCopy | undefined>(() => {
    if (!detail) return undefined;
    const source = {
      projectId: pid,
      projectName: project.name,
      origin: 'history' as const,
      seq: detail.entry.seq,
    };
    return {
      tables: (ids) => reportCopy(() => copyTables(detail.model, ids, { source, layout })),
      items: (tableId, ids) => reportCopy(() => copyItems(detail.model, tableId, ids, { source })),
    };
  }, [detail, pid, project.name, layout, reportCopy]);
  const [prevCopyKey, setPrevCopyKey] = useState(`${open}:${activeSeq}`);
  if (prevCopyKey !== `${open}:${activeSeq}`) {
    setPrevCopyKey(`${open}:${activeSeq}`);
    setCopyStatus(null);
  }

  const openConfirm = () => {
    if (readOnly) return;
    setConflict(null);
    setRestoreError(null);
    resetRestore();
    setConfirmOpen(true);
  };

  const closeConfirm = useCallback(() => {
    setConfirmOpen(false);
    setConflict(null);
    setRestoreError(null);
    resetRestore();
  }, [resetRestore]);

  // 确认框打开期间若权限被实时降级为只读，自动关闭确认框并清空恢复错误与冲突态
  const [prevReadOnly, setPrevReadOnly] = useState(readOnly);
  if (readOnly !== prevReadOnly) {
    setPrevReadOnly(readOnly);
    if (readOnly && confirmOpen) {
      setConfirmOpen(false);
      setConflict(null);
      setRestoreError(null);
    }
  }
  useEffect(() => {
    if (readOnly) resetRestore();
  }, [readOnly, resetRestore]);

  const canRestore = !readOnly && !!detail && !detail.entry.isCurrent && detail.diffToCurrent.total > 0;

  const confirmDiff = conflict?.diffToCurrent ?? detail?.diffToCurrent ?? { total: 0, items: [] };
  const confirmWorkingSeq = conflict?.currentSeq ?? detail?.currentSeq ?? 0;

  const previewTabs: { key: PreviewTab; title: string; count: number }[] = [
    { key: 'opDiff', title: t('hist.tab.opDiff'), count: detail?.opDiff.total ?? 0 },
    { key: 'state', title: t('hist.tab.state'), count: tableCount },
    { key: 'diffToCurrent', title: t('hist.tab.diffToCurrent'), count: detail?.diffToCurrent.total ?? 0 },
  ];

  return (
    <>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onClose={onClose}
        {...({ closedby: 'any' } as object)}
        className="m-auto h-[min(860px,92vh)] max-h-[92vh] w-[min(1280px,96vw)] max-w-none flex-col overflow-hidden rounded-lg border border-border bg-panel p-0 text-text shadow-[var(--shadow-lg)] open:flex"
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-chrome px-4">
          <History size={16} aria-hidden="true" className="text-text-3" />
          <h2 id={titleId} className="m-0 text-[length:var(--fs-lg)] font-semibold">
            {t('hist.title')}
          </h2>
          {open && detail && (
            <div className="flex min-w-0 items-center gap-2 text-xs text-text-2">
              <span className="font-mono font-semibold text-text">#{detail.entry.seq}</span>
              <span className="truncate">{opText(detail.entry.opName)}</span>
              {detail.entry.version && (
                <span className="badge inline-flex items-center gap-1 font-mono">
                  <Tag size={11} aria-hidden="true" />v{detail.entry.version.number}{' '}
                  {detail.entry.version.name}
                </span>
              )}
              {detail.entry.isCurrent && <span className="badge ok">{t('hist.current')}</span>}
            </div>
          )}
          <span className="flex-1" />
          {open && readOnly && <span className="chip">{t('ws.readonlyRole')}</span>}
          {open && canRestore && (
            <button type="button" className="btn primary" onClick={openConfirm}>
              <RotateCcw size={15} aria-hidden="true" />
              {t('hist.restore')}
            </button>
          )}
          <IconButton label={t('dlg.close')} onClick={() => dialogRef.current?.close()}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </header>

        {open && (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* 左侧时间线 */}
            <nav
              aria-label={t('hist.timeline')}
              className="flex w-[290px] shrink-0 flex-col border-r border-border bg-panel max-[1024px]:w-[240px]"
            >
              <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-text-2">
                <span className="font-medium">{t('hist.timelineTitle')}</span>
                {listQuery.data?.pages[0] && (
                  <span className="font-mono text-text-3">#{listQuery.data.pages[0].currentSeq}</span>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {listQuery.error && (
                  <div className="p-1.5">
                    <Banner kind="danger" role="alert">
                      {listQuery.error.message}
                    </Banner>
                  </div>
                )}
                {listQuery.isPending && (
                  <div className="flex items-center gap-2 px-3 py-4 text-xs text-text-2">
                    <LoaderCircle size={14} aria-hidden="true" className="animate-spin" />
                    {t('hist.loading')}
                  </div>
                )}
                {entries.length > 0 && (
                  <ol className="m-0 list-none space-y-1 p-0">
                    {entries.map((entry) => {
                      const active = entry.seq === activeSeq;
                      const actor = entry.user || t('hist.initialUser');
                      return (
                        <li key={entry.seq}>
                          <button
                            type="button"
                            aria-current={active ? 'true' : undefined}
                            onClick={() => {
                              setSelectedSeq(entry.seq);
                              setConflict(null);
                              setRestoreError(null);
                              resetRestore();
                            }}
                            className={cx(
                              'flex w-full flex-col gap-1 rounded-sm border border-transparent px-2.5 py-2 text-left transition-colors',
                              active
                                ? 'border-l-2 border-l-primary bg-primary-soft text-text'
                                : 'text-text hover:bg-surface-hover',
                            )}
                          >
                            <div className="flex items-center gap-1.5">
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                {opText(entry.opName)}
                              </span>
                              <span
                                className={cx(
                                  'shrink-0 font-mono text-xs',
                                  active ? 'text-primary-text' : 'text-text-3',
                                )}
                              >
                                #{entry.seq}
                              </span>
                            </div>

                            {(entry.isCurrent || entry.version) && (
                              <div className="flex flex-wrap items-center gap-1">
                                {entry.isCurrent && <span className="badge ok">{t('hist.current')}</span>}
                                {entry.version && (
                                  <span className="badge font-mono">
                                    v{entry.version.number} {entry.version.name}
                                  </span>
                                )}
                              </div>
                            )}

                            {entry.summary.length > 0 && (
                              <p
                                className={cx(
                                  'm-0 truncate font-mono text-xs',
                                  active ? 'text-text-2' : 'text-text-3',
                                )}
                              >
                                {entry.summary.join(', ')}
                                {entry.changeCount > entry.summary.length
                                  ? ` (+${entry.changeCount - entry.summary.length})`
                                  : ''}
                              </p>
                            )}

                            <div
                              className={cx(
                                'flex items-center justify-between gap-2 text-xs',
                                active ? 'text-text-2' : 'text-text-3',
                              )}
                            >
                              <span className="truncate">{actor}</span>
                              <time dateTime={entry.at} className="shrink-0">
                                {formatTime(entry.at)}
                              </time>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}

                {listQuery.hasNextPage && (
                  <div className="p-2">
                    <button
                      type="button"
                      className="btn w-full"
                      disabled={listQuery.isFetchingNextPage}
                      aria-busy={listQuery.isFetchingNextPage}
                      onClick={() => void listQuery.fetchNextPage()}
                    >
                      {listQuery.isFetchingNextPage ? t('hist.loading') : t('hist.loadMore')}
                    </button>
                  </div>
                )}
              </div>
            </nav>

            {/* 右侧主预览区 */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
              <div
                role="tablist"
                {...({ focusgroup: 'tablist nomemory' } as object)}
                aria-label={t('hist.views')}
                className="flex shrink-0 items-center gap-1 border-b border-border bg-panel px-4"
              >
                {previewTabs.map((item) => {
                  const selected = tab === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      role="tab"
                      id={`${tabBase}-${item.key}`}
                      aria-selected={selected}
                      {...(selected ? { focusgroupstart: '' } : {})}
                      onClick={() => setTab(item.key)}
                      className={cx(
                        'relative inline-flex h-10 items-center gap-1.5 border-0 bg-transparent px-3 text-sm font-medium transition-colors',
                        selected
                          ? 'text-text after:absolute after:inset-x-0 after:bottom-0 after:border-b-2 after:border-primary after:content-[""]'
                          : 'text-text-2 hover:text-text',
                      )}
                    >
                      <span>{item.title}</span>
                      <span className="badge font-mono">{item.count}</span>
                    </button>
                  );
                })}
              </div>

              {detailQuery.error && (
                <div className="p-4">
                  <Banner kind="danger" role="alert">
                    {detailQuery.error.message}
                  </Banner>
                </div>
              )}

              {detailQuery.isPending && (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-text-2">
                  <LoaderCircle size={16} aria-hidden="true" className="animate-spin" />
                  {t('hist.loadingDetail')}
                </div>
              )}

              {detail && (
                <>
                  {/* 维度 1：本次修改 */}
                  <div
                    role="tabpanel"
                    aria-labelledby={`${tabBase}-opDiff`}
                    hidden={tab !== 'opDiff'}
                    tabIndex={tab === 'opDiff' ? 0 : undefined}
                    className="min-h-0 flex-1 overflow-y-auto p-4"
                  >
                    {tab === 'opDiff' && (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-text-2">
                          <span className="font-medium text-text">{opText(detail.entry.opName)}</span>
                          <span>·</span>
                          <span>{detail.entry.user || t('hist.initialUser')}</span>
                          <span>·</span>
                          <time dateTime={detail.entry.at}>{formatTime(detail.entry.at)}</time>
                          {detail.entry.seq > 0 && (
                            <>
                              <span>·</span>
                              <span className="font-mono">
                                #{detail.entry.seq - 1} → #{detail.entry.seq}
                              </span>
                            </>
                          )}
                        </div>

                        {detail.entry.seq === 0 ? (
                          <Banner kind="info">{t('hist.initNoOpDiff')}</Banner>
                        ) : detail.opDiff.total === 0 ? (
                          <Banner kind="info">{t('hist.noOpDiff')}</Banner>
                        ) : (
                          <DiffList items={detail.opDiff.items} total={detail.opDiff.total} />
                        )}
                      </div>
                    )}
                  </div>

                  {/* 维度 2：当时状态 */}
                  <div
                    role="tabpanel"
                    aria-labelledby={`${tabBase}-state`}
                    hidden={tab !== 'state'}
                    tabIndex={tab === 'state' ? 0 : undefined}
                    className={cx('min-h-0 flex-1 flex-col', tab === 'state' ? 'flex overflow-hidden' : '')}
                  >
                    {tab === 'state' && (
                      <>
                        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-panel px-4 py-2">
                          <span className="min-w-0 flex-1 text-xs text-text-2">
                            {t('hist.stateSummary', {
                              seq: detail.entry.seq,
                              tables: tableCount,
                              objects: Object.keys(detail.model.objects).length,
                            })}
                          </span>
                          <fieldset className="seg m-0" aria-label={t('hist.stateMode')}>
                            {(
                              [
                                ['canvas', t('ws.canvas'), Workflow],
                                ['schema', t('hist.schemaView'), List],
                                ['sql', t('ws.sql'), FileCode],
                              ] as const
                            ).map(([k, label, Icon]) => (
                              <button
                                key={k}
                                type="button"
                                aria-pressed={stateView === k}
                                onClick={() => setStateView(k)}
                              >
                                <Icon size={13} aria-hidden="true" />
                                {label}
                              </button>
                            ))}
                          </fieldset>
                        </div>
                        {/* 复制结果：常驻的状态 / 错误区（对话框里不弹通知），文字可换行不截断 */}
                        <div
                          role="status"
                          className={cx(
                            'shrink-0 border-b border-border bg-panel px-4 py-1.5 text-xs text-text-2 empty:border-0 empty:p-0',
                          )}
                        >
                          {copyStatus && !copyStatus.error ? copyStatus.text : null}
                        </div>
                        <div
                          role="alert"
                          className={cx(
                            'shrink-0 border-b border-border bg-panel px-4 py-1.5 text-xs text-danger empty:border-0 empty:p-0',
                          )}
                        >
                          {copyStatus?.error ? copyStatus.text : null}
                        </div>

                        <div className="min-h-0 flex-1 overflow-auto">
                          {stateView === 'canvas' ? (
                            <HistoryCanvasPreview
                              key={detail.entry.seq}
                              model={detail.model}
                              seedLayout={layout}
                              copy={historyCopy}
                            />
                          ) : stateView === 'schema' ? (
                            <HistorySchemaSummary
                              key={detail.entry.seq}
                              model={detail.model}
                              copy={historyCopy}
                            />
                          ) : (
                            <div className="h-full">
                              <SqlView text={ddl} label="DDL" dialect={detail.model.dialect} />
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {/* 维度 3：与当前画布的差异 */}
                  <div
                    role="tabpanel"
                    aria-labelledby={`${tabBase}-diffToCurrent`}
                    hidden={tab !== 'diffToCurrent'}
                    tabIndex={tab === 'diffToCurrent' ? 0 : undefined}
                    className="min-h-0 flex-1 overflow-y-auto p-4"
                  >
                    {tab === 'diffToCurrent' && (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-text-2">
                          <GitCompareArrows size={14} aria-hidden="true" className="text-text-3" />
                          <span>
                            {t('hist.diffHeading', {
                              current: detail.currentSeq,
                              target: detail.entry.seq,
                            })}
                          </span>
                        </div>

                        {detail.entry.isCurrent ? (
                          <Banner kind="info">{t('hist.sameAsCurrent')}</Banner>
                        ) : detail.diffToCurrent.total === 0 ? (
                          <Banner kind="ok">{t('hist.noDiffToCurrent')}</Banner>
                        ) : (
                          <>
                            <Banner kind="info">
                              {t('hist.diffCountHint', { count: detail.diffToCurrent.total })}
                            </Banner>
                            <DiffList items={detail.diffToCurrent.items} total={detail.diffToCurrent.total} />
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </dialog>

      {/* 二次确认对话框作为兄弟节点渲染，避免与外层 <dialog> 发生事件冒泡 */}
      <Modal
        open={confirmOpen && !!detail}
        onClose={closeConfirm}
        size="md"
        title={t('hist.confirmTitle', { seq: detail?.entry.seq ?? 0 })}
        icon={<RotateCcw size={16} aria-hidden="true" />}
        footer={
          <>
            <span className="flex-1" />
            <button type="button" className="btn" autoFocus onClick={closeConfirm}>
              {t('dlg.cancel')}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={readOnly || restore.isPending || confirmDiff.total === 0}
              aria-busy={restore.isPending}
              onClick={() => {
                if (readOnly || !detail) return;
                restore.mutate({
                  seq: detail.entry.seq,
                  workingSeq: confirmWorkingSeq,
                });
              }}
            >
              {restore.isPending
                ? t('hist.restoring')
                : conflict
                  ? t('hist.confirmRetry')
                  : t('hist.confirmAction')}
            </button>
          </>
        }
      >
        {detail && (
          <div className="space-y-3 text-sm">
            {conflict && (
              <Banner kind="warn" role="alert" title={t('hist.conflictTitle')}>
                {t('hist.conflictBody', { currentSeq: conflict.currentSeq })}
              </Banner>
            )}
            {restoreError && (
              <Banner kind="danger" role="alert">
                {restoreError}
              </Banner>
            )}

            <p className="m-0 text-text-2">
              {t('hist.confirmBody', {
                seq: detail.entry.seq,
                op: opText(detail.entry.opName),
                count: confirmDiff.total,
              })}
            </p>

            {confirmDiff.total === 0 ? (
              <Banner kind="ok">{t('hist.noDiffToCurrent')}</Banner>
            ) : (
              <div className="max-h-72 overflow-y-auto">
                <DiffList items={confirmDiff.items} total={confirmDiff.total} />
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
};
