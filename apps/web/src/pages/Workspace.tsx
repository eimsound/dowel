// 模型页：顶栏 + 画布 / SQL + 属性面板 + 状态栏（DESIGN.md：Layout）。
// 对象树在应用外壳的侧面板里（由这里通过 useShellPanel 提供），属性面板默认按需出现、可固定。
import type { CanvasSection, EnvInfo, VersionInfo } from '@dowel/api';
import {
  buildModelIndex,
  ClipboardError,
  type ClipboardPayload,
  copyItems,
  copyTables,
  createAll,
  formatScript,
  newId,
  PasteError,
  planPaste,
} from '@dowel/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  BookmarkPlus,
  ClipboardPaste,
  CloudCheck,
  Copy,
  Database,
  FileCode,
  FileInput,
  GitCompareArrows,
  History,
  Network,
  PanelRight,
  PanelRightClose,
  Plus,
  RefreshCw,
  Users,
  Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import {
  readClipboard,
  readClipboardEvent,
  type ReadResult,
  shouldIgnoreClipboardKey,
  writeClipboard,
  writeClipboardEvent,
} from '../clipboard.ts';
import { Canvas, type CanvasApi } from '../components/Canvas.tsx';
import { CanvasHistory } from '../components/CanvasHistory.tsx';
import { ImportDialog, MigrationDialog, VersionDialog } from '../components/Dialogs.tsx';
import { Inspector } from '../components/Inspector.tsx';
import {
  hasDetails,
  type PasteSummary,
  PasteReportPanel,
  summaryText,
  summaryTitle,
} from '../components/PasteReport.tsx';
import { SectionDialog } from '../components/SectionDialog.tsx';
import { PageHeader, useNarrow, useShellPanel } from '../components/Shell.tsx';
import { type SelectedStore, Sidebar } from '../components/Sidebar.tsx';
import { SqlView } from '../components/SqlView.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useToast } from '../components/Toasts.tsx';
import { Avatar, IconButton, peerColor } from '../components/ui.tsx';
import { nudgeAway, placePastedTables, sectionIndex, sectionsAfterPaste } from '../copy-paste.ts';
import { clearTables, SELECT_TABLE_EVENT, setCurrentTables } from '../current-tables.ts';
import { dialectUiSpec } from '../dialects.ts';
import { useProject } from '../project.tsx';
import {
  buildCanvasGroups,
  type CanvasViewMode,
  type CanvasViewPrefs,
  collectNeighborhood,
  effectiveCanvasMode,
  type FocusState,
  readCanvasViewPrefs,
  resolveTopLevelTableId,
  type SidebarGrouping,
  writeCanvasViewPrefs,
} from '../sections.ts';
import { useWorkspace } from '../workspace.ts';

type DialogKey = 'import' | 'publish' | 'migration' | 'history' | 'sections' | null;

/** 属性面板的固定状态存在 localStorage（DESIGN.md：Layout） */
const PIN_KEY = 'dowel.inspector';
const readPinned = () => localStorage.getItem(PIN_KEY) === 'pinned';

export const Model = () => {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const { pid, project, me } = useProject();
  const params = { owner: project.group.slug, project: project.slug };
  const envs = useQuery({
    queryKey: ['envs', pid],
    queryFn: () => api<EnvInfo[]>('GET', `/api/projects/${pid}/environments`),
  });
  const versions = useQuery({
    queryKey: ['versions', pid],
    queryFn: () => api<VersionInfo[]>('GET', `/api/projects/${pid}/versions`),
  });
  const { ws, model, status, pending, layout, sections, peers, role: liveRole } = useWorkspace(pid, toast);
  const modelIndex = useMemo(() => buildModelIndex(model), [model]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(selected);
  const selectedListenersRef = useRef(new Set<() => void>());
  const selectedStore = useMemo<SelectedStore>(
    () => ({
      getSnapshot: () => selectedRef.current,
      subscribe: (fn) => {
        selectedListenersRef.current.add(fn);
        return () => selectedListenersRef.current.delete(fn);
      },
    }),
    [],
  );
  /** 多选的表（复制用）；为空时只看 selected */
  const [multi, setMulti] = useState<string[]>([]);
  const updateSelected = useCallback((id: string | null) => {
    selectedRef.current = id;
    for (const fn of selectedListenersRef.current) fn();
    setSelected(id);
    setMulti([]);
  }, []);
  const setPrimary = useCallback((id: string | null) => {
    selectedRef.current = id;
    for (const fn of selectedListenersRef.current) fn();
    setSelected(id);
  }, []);
  useLayoutEffect(() => {
    if (selectedRef.current !== selected) {
      selectedRef.current = selected;
      for (const fn of selectedListenersRef.current) fn();
    }
  }, [selected]);
  const [tab, setTab] = useState<'canvas' | 'sql'>('canvas');
  const [dialog, setDialog] = useState<DialogKey>(null);
  const [sectionDialogMode, setSectionDialogMode] = useState<'manage' | 'suggest'>('manage');
  const [relayout, setRelayout] = useState(0);
  const [pinned, setPinned] = useState(readPinned);
  const [viewPrefs, setViewPrefs] = useState<CanvasViewPrefs>(() => readCanvasViewPrefs(pid));
  const [prevPid, setPrevPid] = useState(pid);
  if (pid !== prevPid) {
    setPrevPid(pid);
    setViewPrefs(readCanvasViewPrefs(pid));
  }
  const viewPrefsRef = useRef<CanvasViewPrefs>(viewPrefs);
  const sidebarGroupingRef = useRef<SidebarGrouping>(viewPrefs.sidebarGrouping);
  useLayoutEffect(() => {
    viewPrefsRef.current = viewPrefs;
    sidebarGroupingRef.current = viewPrefs.sidebarGrouping;
  }, [pid, viewPrefs]);

  const updateViewPrefs = useCallback(
    (updater: (prev: CanvasViewPrefs) => CanvasViewPrefs) => {
      setViewPrefs((prev) => {
        const base: CanvasViewPrefs = { ...prev, sidebarGrouping: sidebarGroupingRef.current };
        const next = updater(base);
        if (next === base) return prev;
        sidebarGroupingRef.current = next.sidebarGrouping;
        viewPrefsRef.current = next;
        writeCanvasViewPrefs(pid, next);
        return next;
      });
    },
    [pid],
  );
  const narrow = useNarrow();
  // WebSocket 推来的角色（成员 / 授权变动后即时生效）优先于页面加载时的角色
  const role = liveRole ?? project.role;
  const readOnly = role === 'viewer';
  // 角色被改时提示一次：降级为查看者时编辑区已经自动关掉了。
  const prevRole = useRef<string | null>(project.role);
  useEffect(() => {
    if (!liveRole) return;
    const prev = prevRole.current ?? project.role;
    if (prev && prev !== liveRole) {
      toast(liveRole === 'viewer' ? t('ws.downgraded') : t('ws.upgraded'));
      void qc.invalidateQueries({ queryKey: ['project', pid] });
      void qc.invalidateQueries({ queryKey: ['access', pid] });
    }
    prevRole.current = liveRole;
  }, [liveRole, project.role, qc, pid, toast, t]);

  const uiSpec = dialectUiSpec(model.dialect);
  const newSequence = useCallback(() => {
    if (readOnly || !uiSpec.sequences) return;
    const schema =
      Object.values(model.objects).find((o) => o.kind === 'schema' && o.name === uiSpec.defaultSchema) ??
      Object.values(model.objects).find((o) => o.kind === 'schema');
    if (!schema) return;
    const taken = new Set(
      Object.values(model.objects)
        .filter((o) => o.kind === 'table' || o.kind === 'sequence')
        .map((o) => o.name.toLowerCase()),
    );
    let n = 1;
    while (taken.has(`seq_${n}`)) n++;
    const id = newId();
    if (ws.act('createSequence', { id, schema: schema.id, name: `seq_${n}` })) {
      updateSelected(id);
    }
  }, [model.objects, readOnly, uiSpec.defaultSchema, uiSpec.sequences, updateSelected, ws]);

  const openSectionManager = useCallback((mode: 'manage' | 'suggest' = 'manage') => {
    setSectionDialogMode(mode);
    setDialog('sections');
  }, []);
  const openManageSections = useCallback(() => openSectionManager('manage'), [openSectionManager]);

  const persistSidebarGrouping = useCallback(
    (sidebarGrouping: SidebarGrouping) => {
      if (sidebarGroupingRef.current === sidebarGrouping) return;
      sidebarGroupingRef.current = sidebarGrouping;
      const next: CanvasViewPrefs = { ...viewPrefsRef.current, sidebarGrouping };
      viewPrefsRef.current = next;
      writeCanvasViewPrefs(pid, next);
    },
    [pid],
  );

  const setCanvasViewMode = useCallback(
    (viewMode: CanvasViewMode) => updateViewPrefs((prev) => ({ ...prev, viewMode })),
    [updateViewPrefs],
  );

  const toggleExpandedGroup = useCallback(
    (groupId: string) =>
      updateViewPrefs((prev) => ({
        ...prev,
        expandedGroups: prev.expandedGroups.includes(groupId)
          ? prev.expandedGroups.filter((g) => g !== groupId)
          : [...prev.expandedGroups, groupId],
      })),
    [updateViewPrefs],
  );

  const collapseAllGroups = useCallback(
    () => updateViewPrefs((prev) => ({ ...prev, expandedGroups: [] })),
    [updateViewPrefs],
  );

  const setFocusState = useCallback(
    (focus: FocusState | null) => updateViewPrefs((prev) => ({ ...prev, focus })),
    [updateViewPrefs],
  );

  const exitFocus = useCallback(() => setFocusState(null), [setFocusState]);

  const focusTable = useCallback(
    (tableId: string) => {
      const topId = resolveTopLevelTableId(model, tableId) ?? tableId;
      updateSelected(tableId);
      updateViewPrefs((prev) => ({
        ...prev,
        focus: { tableId: topId, hops: prev.focus?.hops ?? 1 },
      }));
    },
    [model, updateSelected, updateViewPrefs],
  );

  const topTableCount = useMemo(
    () => modelIndex.allRef('table').filter((tb) => !tb.partitionOf).length,
    [modelIndex],
  );
  const canvasGroups = useMemo(
    () => buildCanvasGroups(model, sections, modelIndex),
    [model, sections, modelIndex],
  );

  // 选中对象时若在汇总折叠视图下自动展开所属板块，若在聚焦模式外则切到以它为中心的邻域，确保画布可见
  const handleSelectObject = useCallback(
    (id: string | null) => {
      updateSelected(id);
      if (!id) return;
      const topId = resolveTopLevelTableId(model, id);
      if (!topId) return;
      if (viewPrefs.focus) {
        const nbrs = collectNeighborhood(model, viewPrefs.focus.tableId, viewPrefs.focus.hops, modelIndex);
        if (!nbrs.has(topId)) {
          updateViewPrefs((prev) => ({
            ...prev,
            focus: { tableId: topId, hops: prev.focus?.hops ?? 1 },
          }));
        }
        return;
      }
      if (effectiveCanvasMode(viewPrefs.viewMode, topTableCount) === 'sections') {
        const gid = canvasGroups.tableToGroup.get(topId);
        if (gid && !viewPrefs.expandedGroups.includes(gid)) {
          updateViewPrefs((prev) =>
            prev.expandedGroups.includes(gid)
              ? prev
              : { ...prev, expandedGroups: [...prev.expandedGroups, gid] },
          );
        }
      }
    },
    [
      canvasGroups.tableToGroup,
      model,
      modelIndex,
      topTableCount,
      updateSelected,
      updateViewPrefs,
      viewPrefs.expandedGroups,
      viewPrefs.focus,
      viewPrefs.viewMode,
    ],
  );

  const handleSelectObjectRef = useRef(handleSelectObject);
  useLayoutEffect(() => {
    handleSelectObjectRef.current = handleSelectObject;
  });

  // 对象树放在应用外壳的侧面板里；通过 selectedStore 在叶行局部更新选中态，避免点击节点重渲染整棵树
  useShellPanel(
    t('ws.objects'),
    <Sidebar
      key={pid}
      model={model}
      modelIndex={modelIndex}
      selectedStore={selectedStore}
      onSelect={handleSelectObject}
      onAddSequence={!readOnly && uiSpec.sequences ? newSequence : undefined}
      sections={sections}
      defaultGrouping={viewPrefs.sidebarGrouping}
      onChangeGrouping={persistSidebarGrouping}
      readOnly={readOnly}
      onOpenSectionManager={openSectionManager}
      onFocusTable={focusTable}
      onExitFocus={exitFocus}
      focusedTableId={viewPrefs.focus?.tableId ?? null}
    />,
    [
      pid,
      model,
      modelIndex,
      selectedStore,
      handleSelectObject,
      t,
      readOnly,
      uiSpec.sequences,
      newSequence,
      sections,
      persistSidebarGrouping,
      openSectionManager,
      focusTable,
      exitFocus,
      viewPrefs.focus?.tableId,
    ],
  );

  // 命令面板要能搜到当前模型里的表：把表清单登记到一个模块级的小注册表（离开模型页时清空）
  useEffect(() => {
    setCurrentTables(pid, model);
    return () => clearTables(pid);
  }, [pid, model]);

  // 命令面板选中一张表：直接在当前画布上选中它
  useEffect(() => {
    const onSelect = (e: Event) => handleSelectObject((e as CustomEvent<string>).detail);
    window.addEventListener(SELECT_TABLE_EVENT, onSelect);
    return () => window.removeEventListener(SELECT_TABLE_EVENT, onSelect);
  }, [handleSelectObject]);

  /** 画布全选（⌘A）用：选择逻辑在后面定义，键盘监听先挂上 */
  const selectManyRef = useRef<(ids: string[]) => void>(() => {});
  const canvasApi = useRef<CanvasApi | null>(null);
  // Esc 取消选中：属性面板按需时随之消失。编辑中的输入框、对话框里的 Esc 留给它们自己。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // ⌘A / Ctrl+A：焦点在画布上（或页面本身）时选中画布上显示的全部表
      if (
        e.key.toLowerCase() === 'a' &&
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (el?.closest('.react-flow') || el === document.body) &&
        !document.querySelector('dialog[open]')
      ) {
        if (el.closest('input, textarea, select, [contenteditable="true"], dialog, [popover]')) return;
        const ids = canvasApi.current?.visibleTableIds() ?? [];
        if (!ids.length) return;
        e.preventDefault();
        selectManyRef.current(ids);
        return;
      }
      if (e.key !== 'Escape') return;
      // 焦点在粘贴结果面板里：Esc 关掉面板（不动画布选择）
      const report = el?.closest('[data-testid="paste-report"]');
      if (report) {
        report.querySelector<HTMLButtonElement>('[data-dismiss]')?.click();
        return;
      }
      if (
        el?.closest(
          'input, textarea, select, [contenteditable="true"], dialog, [popover], [data-testid="paste-report"]',
        )
      )
        return;
      updateSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [updateSelected]);

  const ddl = useMemo(() => {
    if (tab !== 'sql') return '';
    try {
      return formatScript(
        createAll(
          model,
          model.dialect === 'pg' && project.targetPgMajor !== null
            ? { pgMajor: project.targetPgMajor }
            : undefined,
        ),
        model.dialect,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return msg
        .split('\n')
        .map((line) => `-- ${line}`)
        .join('\n');
    }
  }, [model, tab, project.targetPgMajor]);
  const onMove = useCallback((l: Parameters<typeof ws.move>[0]) => !readOnly && ws.move(l), [ws, readOnly]);
  const onSetSections = useCallback(
    (next: CanvasSection[]) => {
      if (!readOnly) ws.setSections(next);
    },
    [ws, readOnly],
  );
  const close = useCallback(() => setDialog(null), []);

  // ───── 复制粘贴（ADR 0013 第 2 节） ─────
  const copyHintId = useId();
  const [pasteSummary, setPasteSummary] = useState<PasteSummary | null>(null);
  const [prevPastePid, setPrevPastePid] = useState(pid);
  if (pid !== prevPastePid) {
    setPrevPastePid(pid);
    setPasteSummary(null);
  }
  const isTable = useCallback((id: string | null) => !!id && model.objects[id]?.kind === 'table', [model]);
  /** 多选里仍然存在的表（协作者可能刚删掉其中几张） */
  const liveMulti = useMemo(() => {
    const ids = multi.filter((id) => model.objects[id]?.kind === 'table');
    return ids.length === multi.length ? multi : ids;
  }, [multi, model]);
  /** 当前要复制的表：多选优先，否则是选中的那张表 */
  const copyTargets = useMemo(() => {
    if (liveMulti.length) return liveMulti;
    return selected && model.objects[selected]?.kind === 'table' ? [selected] : [];
  }, [liveMulti, selected, model]);

  const toggleSelect = useCallback(
    (id: string) => {
      const base = liveMulti.length ? liveMulti : selected && isTable(selected) ? [selected] : [];
      const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
      setMulti(next.length > 1 ? next : []);
      setPrimary(next.includes(id) ? id : (next.at(-1) ?? null));
    },
    [liveMulti, selected, isTable, setPrimary],
  );
  const selectMany = useCallback(
    (ids: string[]) => {
      const tables = ids.filter((id) => model.objects[id]?.kind === 'table');
      setMulti(tables.length > 1 ? tables : []);
      setPrimary(tables[0] ?? null);
    },
    [model, setPrimary],
  );
  useLayoutEffect(() => {
    selectManyRef.current = selectMany;
  });

  const source = useCallback(
    () => ({ projectId: pid, projectName: project.name, origin: 'canvas' as const, seq: null }),
    [pid, project.name],
  );
  const buildTablesPayload = useCallback(
    (ids: string[]) =>
      copyTables(model, ids, { source: source(), layout, sections: sectionIndex(sections, ids) }),
    [model, layout, sections, source],
  );
  const copyFeedback = useCallback(
    (p: ClipboardPayload) => {
      if (p.kind === 'tables') toast(t('clip.copiedTables', { count: p.tables.length }));
      else toast(t('clip.copiedItems', { count: p.items.length }));
    },
    [t, toast],
  );
  const copyError = useCallback(
    (e: unknown) => {
      if (e instanceof ClipboardError && e.code === 'too_large') toast(t('clip.tooLarge'), 'error');
      else toast(t('clip.copyFailed', { reason: e instanceof Error ? e.message : String(e) }), 'error');
    },
    [t, toast],
  );
  /** 按钮触发的复制（表） */
  const copyTableIds = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      try {
        const p = buildTablesPayload(ids);
        void writeClipboard(p).then(() => copyFeedback(p));
      } catch (e) {
        copyError(e);
      }
    },
    [buildTablesPayload, copyFeedback, copyError],
  );
  /** 按钮触发的复制（表内列 / 约束 / 索引） */
  const copyTableItems = useCallback(
    (tableId: string, itemIds: string[]) => {
      if (!itemIds.length) return;
      try {
        const p = copyItems(model, tableId, itemIds, { source: source() });
        void writeClipboard(p).then(() => copyFeedback(p));
      } catch (e) {
        copyError(e);
      }
    },
    [model, source, copyFeedback, copyError],
  );

  /** 粘贴后要选中的新表：等模型里出现它们再选（此刻的 model 还是粘贴前的） */
  const pendingSelect = useRef<string[] | null>(null);
  useEffect(() => {
    const ids = pendingSelect.current;
    if (!ids || !ids.every((id) => model.objects[id])) return;
    pendingSelect.current = null;
    handleSelectObject(ids[0]!);
    if (ids.length > 1) setMulti(ids);
  }, [model, handleSelectObject]);
  const pasteButtonRef = useRef<HTMLButtonElement>(null);
  const [announce, setAnnounce] = useState('');
  const lastAnnounce = useRef('');
  const speak = useCallback((text: string) => {
    // 读屏对与上次完全相同的消息不再播报：重复时补一个不换行空格
    const next = text === lastAnnounce.current ? `${text}\u00A0` : text;
    lastAnnounce.current = next;
    setAnnounce(next);
  }, []);

  const pasteResult = useCallback(
    (r: ReadResult, mode: 'any' | 'items' = 'any') => {
      if (!r.ok) {
        if (r.reason === 'unsupported_version') toast(t('clip.unsupportedVersion'), 'error');
        else toast(t('clip.nothingToPaste'), 'notice');
        return;
      }
      const payload = r.payload;
      if (readOnly) {
        toast(t('clip.readOnly'), 'notice');
        return;
      }
      if (payload.dialect !== model.dialect) {
        toast(
          t('clip.dialectMismatch', {
            from: dialectUiSpec(payload.dialect).name,
            to: dialectUiSpec(model.dialect).name,
          }),
          'error',
        );
        return;
      }
      if (mode === 'items' && payload.kind === 'tables') {
        toast(t('clip.pasteIntoTables'), 'notice');
        return;
      }
      // 表内粘贴只往唯一选中的那张表里贴；多选时不猜目标
      const targetTable =
        payload.kind === 'items' && liveMulti.length <= 1 && isTable(selected) ? selected : null;
      if (payload.kind === 'items' && !targetTable) {
        toast(t('clip.needTarget'), 'error');
        return;
      }
      let plan;
      try {
        plan = planPaste(model, payload, { targetTable });
      } catch (e) {
        if (e instanceof PasteError) {
          toast(
            t(`clip.pasteError.${e.code}`, {
              ...e.params,
              defaultValue: t('clip.failed', { reason: e.message }),
            }),
            'error',
          );
          return;
        }
        // 载荷来自剪贴板（可能被其他程序改过）：任何意外错误都只提示，不让事件处理抛出
        toast(t('clip.failed', { reason: e instanceof Error ? e.message : String(e) }), 'error');
        return;
      }
      const targetName = plan.targetTable ? (model.objects[plan.targetTable]?.name ?? null) : null;
      const count = payload.kind === 'tables' ? plan.newTables.length : plan.newItems.length;
      const summary: PasteSummary = { kind: payload.kind, count, table: targetName, report: plan.report };
      if (plan.ops.length === 0) {
        if (hasDetails(plan.report)) {
          setPasteSummary(summary);
          speak(summaryText(t, summary));
        } else {
          setPasteSummary(null);
          toast(t('clip.nothingPasted'), 'notice');
        }
        return;
      }
      if (!ws.act('paste', { ops: plan.ops })) return;
      if (payload.kind === 'tables') {
        const positions = nudgeAway(
          placePastedTables(payload, plan, canvasApi.current?.viewportCenter() ?? null),
          layout,
        );
        if (Object.keys(positions).length) ws.move(positions);
        const nextSections = sectionsAfterPaste(sections, payload, plan, pid);
        if (nextSections) ws.setSections(nextSections);
        pendingSelect.current = plan.newTables.length ? plan.newTables : null;
      }
      if (hasDetails(plan.report)) {
        setPasteSummary(summary);
        speak(summaryText(t, summary));
      } else {
        setPasteSummary(null);
        toast(summaryTitle(t, summary));
      }
    },
    [readOnly, model, selected, liveMulti.length, isTable, ws, layout, sections, pid, toast, t, speak],
  );
  const pasteFromButton = useCallback(() => {
    void readClipboard().then((r) => pasteResult(r));
  }, [pasteResult]);
  const pasteIntoTable = useCallback(() => {
    void readClipboard().then((r) => pasteResult(r, 'items'));
  }, [pasteResult]);
  const closePasteReport = useCallback(() => {
    setPasteSummary(null);
    // 关闭按钮随面板卸载：焦点回到顶栏的“粘贴”，没有就交给画布
    const target = pasteButtonRef.current ?? document.querySelector<HTMLElement>('.react-flow');
    target?.focus();
  }, []);
  const clipCtx = useMemo(
    () => ({
      copyTables: copyTableIds,
      copyItems: copyTableItems,
      pasteInto: readOnly ? undefined : pasteIntoTable,
    }),
    [copyTableIds, copyTableItems, readOnly, pasteIntoTable],
  );
  const clearSelection = useCallback(() => updateSelected(null), [updateSelected]);

  // 键盘 ⌘C / ⌘V：走 copy / paste 事件（同步、无权限弹窗）；输入框、编辑器、对话框里交给浏览器
  const clipRef = useRef({ copyTargets, buildTablesPayload, copyFeedback, copyError, pasteResult });
  useLayoutEffect(() => {
    clipRef.current = { copyTargets, buildTablesPayload, copyFeedback, copyError, pasteResult };
  });
  const tabRef = useRef(tab);
  useLayoutEffect(() => {
    tabRef.current = tab;
  });
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      // SQL 视图里复制的是 DDL 文本，交给浏览器
      if (tabRef.current !== 'canvas' || shouldIgnoreClipboardKey(e, 'copy')) return;
      const c = clipRef.current;
      if (!c.copyTargets.length) return;
      try {
        const p = c.buildTablesPayload(c.copyTargets);
        writeClipboardEvent(e, p);
        e.preventDefault();
        c.copyFeedback(p);
      } catch (err) {
        c.copyError(err);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (tabRef.current !== 'canvas' || shouldIgnoreClipboardKey(e, 'paste')) return;
      e.preventDefault();
      clipRef.current.pasteResult(readClipboardEvent(e));
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
    };
  }, []);
  const people = useMemo(() => {
    const names = [...new Set(peers.map((p) => p.user))];
    return [me.name, ...names.filter((n) => n !== me.name)];
  }, [peers, me.name]);
  const togglePin = () => {
    setPinned((v) => {
      const next = !v;
      localStorage.setItem(PIN_KEY, next ? 'pinned' : 'auto');
      return next;
    });
  };

  const newTable = () => {
    const schema =
      Object.values(model.objects).find((o) => o.kind === 'schema' && o.name === uiSpec.defaultSchema) ??
      Object.values(model.objects).find((o) => o.kind === 'schema');
    if (!schema) return;
    const names = new Set(
      Object.values(model.objects)
        .filter((o) => o.kind === 'table')
        .map((o) => o.name),
    );
    let n = 1;
    while (names.has(`table_${n}`)) n++;
    const id = newId();
    const colId = newId();
    if (ws.act('createTable', { id, schema: schema.id, name: `table_${n}` })) {
      const col = uiSpec.defaultPkColumn(colId);
      if (ws.act('addColumn', { table: id, column: col }) && uiSpec.autoPrimaryKey) {
        ws.act('addPrimaryKey', { id: newId(), table: id, columns: [colId] });
      }
      updateSelected(id);
    }
  };

  const env = envs.data?.[0];
  const latest = versions.data?.[0];
  const showInspector = pinned || selected !== null || liveMulti.length > 1;
  const dialectLabel =
    model.dialect === 'pg'
      ? project.targetPgMajor !== null
        ? `PostgreSQL ${project.targetPgMajor}+`
        : 'PostgreSQL'
      : uiSpec.name;
  const dialectTip =
    model.dialect !== 'pg'
      ? undefined
      : project.targetPgMajor !== null
        ? project.envPgMajors.length > 1
          ? t('ws.pgTargetMultiTip', {
              target: project.targetPgMajor,
              versions: project.envPgMajors.map((v) => `PG ${v}`).join(' · '),
            })
          : t('ws.pgTargetSingleTip', { target: project.targetPgMajor })
        : t('ws.pgTargetUnknownTip');

  return (
    <>
      <PageHeader
        crumbs={[
          { label: project.group.name, to: '/group/$slug', params: { slug: project.group.slug } },
          { label: project.name, to: '/project/$owner/$project', params },
          { label: t('nav.model') },
        ]}
        center={
          <>
            <div className="flex gap-1.5">
              {!readOnly && (
                <>
                  <button type="button" className="btn" onClick={newTable}>
                    <Plus size={16} aria-hidden="true" />
                    {t('ws.newTable')}
                  </button>
                  <IconButton
                    label={t('ws.autoLayout')}
                    variant="secondary"
                    onClick={() => setRelayout((x) => x + 1)}
                  >
                    <Network size={16} aria-hidden="true" />
                  </IconButton>
                </>
              )}
              <IconButton
                label={
                  copyTargets.length
                    ? t('clip.copySelected', { count: copyTargets.length })
                    : t('clip.copySelectedNone')
                }
                variant="secondary"
                aria-disabled={copyTargets.length === 0 || undefined}
                aria-describedby={copyTargets.length === 0 ? copyHintId : undefined}
                onClick={() => {
                  if (copyTargets.length) copyTableIds(copyTargets);
                }}
              >
                <Copy size={16} aria-hidden="true" />
              </IconButton>
              <span id={copyHintId} className="sr-only">
                {t('clip.selectFirst')}
              </span>
              {!readOnly && (
                <IconButton
                  ref={pasteButtonRef}
                  label={t('clip.pasteButton')}
                  variant="secondary"
                  onClick={pasteFromButton}
                >
                  <ClipboardPaste size={16} aria-hidden="true" />
                </IconButton>
              )}
            </div>
            <span className="h-5 w-px bg-border" aria-hidden="true" />
            <div className="flex gap-1.5">
              {!readOnly && (
                <button
                  type="button"
                  className="btn"
                  aria-label={t('ws.import')}
                  title={t('ws.import')}
                  onClick={() => setDialog('import')}
                >
                  <FileInput size={16} aria-hidden="true" />
                  <span className="max-[1080px]:hidden">{t('ws.import')}</span>
                </button>
              )}
              <Link
                to="/project/$owner/$project/environments"
                params={params}
                className="btn"
                aria-label={t('nav.environments')}
                title={t('nav.environments')}
              >
                <Database size={16} aria-hidden="true" />
                <span className="max-[1080px]:hidden">{t('nav.environments')}</span>
              </Link>
            </div>
            <span className="h-5 w-px bg-border" aria-hidden="true" />
            <div className="flex gap-1.5">
              <button
                type="button"
                className="btn"
                aria-label={t('hist.open')}
                title={t('hist.open')}
                onClick={() => setDialog('history')}
              >
                <History size={16} aria-hidden="true" />
                <span className="max-[1080px]:hidden">{t('hist.open')}</span>
              </button>
              {!readOnly && (
                <button
                  type="button"
                  className="btn"
                  aria-label={t('ws.saveVersion')}
                  title={t('ws.saveVersion')}
                  onClick={() => setDialog('publish')}
                >
                  <BookmarkPlus size={16} aria-hidden="true" />
                  <span className="max-[1080px]:hidden">{t('ws.saveVersion')}</span>
                </button>
              )}
              <button type="button" className="btn primary" onClick={() => setDialog('migration')}>
                <GitCompareArrows size={16} aria-hidden="true" />
                {t('ws.migration')}
              </button>
            </div>
          </>
        }
        actions={
          <>
            <span role="status" className="flex items-center gap-1 text-xs whitespace-nowrap text-text-3">
              {status === 'online' ? (
                <CloudCheck size={14} aria-hidden="true" className="text-ok" />
              ) : (
                <RefreshCw size={14} aria-hidden="true" className="animate-spin text-warn" />
              )}
              {pending > 0 ? t('ws.pending', { count: pending }) : t(`ws.sync.${status}`)}
            </span>
            {readOnly && <span className="chip">{t('ws.readonlyRole')}</span>}
            <ul aria-label={t('ws.online')} className="m-0 mr-1 flex list-none p-0">
              {people.slice(0, 4).map((name, i) => (
                <li key={name} className="contents">
                  <Avatar
                    name={name}
                    color={i === 0 ? 'var(--me)' : peerColor(i - 1)}
                    title={i === 0 ? t('ws.you', { name }) : name}
                  />
                </li>
              ))}
              {people.length > 4 && (
                <li className="contents">
                  <span className="avatar bg-surface-active text-text-2">+{people.length - 4}</span>
                </li>
              )}
            </ul>
            <Link
              to="/project/$owner/$project/members"
              params={params}
              className="btn icon ghost"
              aria-label={t('nav.members')}
              title={t('nav.members')}
            >
              <Users size={16} aria-hidden="true" />
            </Link>
            <IconButton
              label={pinned ? t('insp.unpin') : t('insp.pin')}
              aria-pressed={pinned}
              onClick={togglePin}
            >
              {pinned ? (
                <PanelRightClose size={16} aria-hidden="true" />
              ) : (
                <PanelRight size={16} aria-hidden="true" />
              )}
            </IconButton>
          </>
        }
      />

      <main className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--canvas)]">
          <Tabs
            label={t('ws.view')}
            floating
            tabs={[
              { key: 'canvas', title: t('ws.canvas'), icon: <Workflow size={14} aria-hidden="true" /> },
              { key: 'sql', title: t('ws.sql'), icon: <FileCode size={14} aria-hidden="true" /> },
            ]}
            value={tab}
            onChange={setTab}
          >
            {(k) =>
              k === 'canvas' ? (
                <div className="relative h-full">
                  <Canvas
                    model={model}
                    modelIndex={modelIndex}
                    layout={layout}
                    selected={selected}
                    onSelect={handleSelectObject}
                    onMove={onMove}
                    relayout={relayout}
                    sections={sections}
                    viewMode={viewPrefs.viewMode}
                    expandedGroups={viewPrefs.expandedGroups}
                    onToggleGroup={toggleExpandedGroup}
                    onCollapseAllGroups={collapseAllGroups}
                    focus={viewPrefs.focus}
                    onChangeFocus={setFocusState}
                    onChangeViewMode={setCanvasViewMode}
                    readOnly={readOnly}
                    multi={liveMulti}
                    onToggleSelect={toggleSelect}
                    onSelectMany={selectMany}
                    onCopyGroup={copyTableIds}
                    apiRef={canvasApi}
                  />
                  <div aria-live="polite" className="sr-only">
                    {announce}
                  </div>
                  {pasteSummary && (
                    <div className="pointer-events-none absolute inset-x-3 bottom-14 z-10 flex">
                      <PasteReportPanel
                        summary={pasteSummary}
                        onClose={closePasteReport}
                        onOpenHistory={() => setDialog('history')}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="h-full pt-12">
                  <SqlView text={ddl} label="DDL" dialect={model.dialect} />
                </div>
              )
            }
          </Tabs>
        </div>

        {showInspector && (
          <aside
            aria-label={t('ws.inspector')}
            className={
              // 窄屏（< 1024）属性面板覆盖在画布上，不挤压画布（DESIGN.md：Responsive Behavior）
              narrow
                ? 'fixed top-[var(--topbar-h)] right-0 bottom-[var(--statusbar-h)] z-30 flex w-[300px] flex-col border-l border-border bg-panel shadow-[var(--shadow-pop)]'
                : 'flex w-[var(--inspector-w)] shrink-0 flex-col border-l border-border bg-panel max-[1279px]:w-[300px]'
            }
          >
            <Inspector
              selected={selected}
              ws={ws}
              model={model}
              modelIndex={modelIndex}
              readOnly={readOnly}
              onSelect={handleSelectObject}
              sections={sections}
              onSetSections={onSetSections}
              onOpenSectionManager={openManageSections}
              focusedTableId={viewPrefs.focus?.tableId ?? null}
              onFocusTable={focusTable}
              onExitFocus={exitFocus}
              multi={liveMulti}
              clip={clipCtx}
              onClearMulti={clearSelection}
            />
          </aside>
        )}
      </main>

      <footer className="flex h-[var(--statusbar-h)] shrink-0 items-center gap-4 border-t border-border bg-chrome px-3 text-xs text-text-3">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`size-[7px] rounded-full ${status === 'online' ? 'bg-ok' : 'bg-warn'}`}
          />
          {t(`ws.status.${status}`)}
          {status === 'online' && ` · ${t('ws.peopleOnline', { count: people.length })}`}
        </span>
        <span>
          {!uiSpec.requiresExternalShadow
            ? t('ws.shadowMemory')
            : env
              ? t('ws.shadowOf', { env: env.name })
              : t('ws.noEnv')}
        </span>
        <span className="flex-1" />
        {latest && <span className="font-mono">{latest.name}</span>}
        <span className="font-mono" title={dialectTip}>
          {dialectLabel}
        </span>
      </footer>

      <ImportDialog pid={pid} open={dialog === 'import'} onClose={close} />
      <VersionDialog pid={pid} open={dialog === 'publish'} onClose={close} />
      <MigrationDialog pid={pid} open={dialog === 'migration'} onClose={close} />
      <CanvasHistory
        pid={pid}
        open={dialog === 'history'}
        onClose={close}
        readOnly={readOnly}
        layout={layout}
      />
      <SectionDialog
        open={dialog === 'sections'}
        initialMode={sectionDialogMode}
        onClose={close}
        model={model}
        sections={sections}
        readOnly={readOnly}
        onSaveSections={onSetSections}
      />
    </>
  );
};
