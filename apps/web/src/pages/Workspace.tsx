// 模型页：顶栏 + 画布 / SQL + 属性面板 + 状态栏（DESIGN.md：Layout）。
// 对象树在应用外壳的侧面板里（由这里通过 useShellPanel 提供），属性面板默认按需出现、可固定。
import type { EnvInfo, VersionInfo } from '@dowel/api';
import { createAll, newId } from '@dowel/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  BookmarkPlus,
  CloudCheck,
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { Canvas } from '../components/Canvas.tsx';
import { CanvasHistory } from '../components/CanvasHistory.tsx';
import { ImportDialog, MigrationDialog, VersionDialog } from '../components/Dialogs.tsx';
import { Inspector } from '../components/Inspector.tsx';
import { PageHeader, useNarrow, useShellPanel } from '../components/Shell.tsx';
import { Sidebar } from '../components/Sidebar.tsx';
import { SqlView } from '../components/SqlView.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useToast } from '../components/Toasts.tsx';
import { Avatar, IconButton, peerColor } from '../components/ui.tsx';
import { clearTables, SELECT_TABLE_EVENT, setCurrentTables } from '../current-tables.ts';
import { useProject } from '../project.tsx';
import { useWorkspace } from '../workspace.ts';

type DialogKey = 'import' | 'publish' | 'migration' | 'history' | null;

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
  const { ws, model, status, pending, layout, peers, role: liveRole } = useWorkspace(pid, toast);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'canvas' | 'sql'>('canvas');
  const [dialog, setDialog] = useState<DialogKey>(null);
  const [relayout, setRelayout] = useState(0);
  const [pinned, setPinned] = useState(readPinned);
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

  // 对象树放在应用外壳的侧面板里；选中项变化时更新
  useShellPanel(t('ws.objects'), <Sidebar model={model} selected={selected} onSelect={setSelected} />, [
    model,
    selected,
    t,
  ]);

  // 命令面板要能搜到当前模型里的表：把表清单登记到一个模块级的小注册表（离开模型页时清空）
  useEffect(() => {
    setCurrentTables(pid, model);
    return () => clearTables(pid);
  }, [pid, model]);

  // 命令面板选中一张表：直接在当前画布上选中它
  useEffect(() => {
    const onSelect = (e: Event) => setSelected((e as CustomEvent<string>).detail);
    window.addEventListener(SELECT_TABLE_EVENT, onSelect);
    return () => window.removeEventListener(SELECT_TABLE_EVENT, onSelect);
  }, []);

  // Esc 取消选中：属性面板按需时随之消失。编辑中的输入框、对话框里的 Esc 留给它们自己。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"], dialog, [popover]')) return;
      setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ddl = useMemo(
    () =>
      tab === 'sql'
        ? createAll(model)
            .map((s) => `${s.sql};`)
            .join('\n\n')
        : '',
    [model, tab],
  );
  const onMove = useCallback((l: Parameters<typeof ws.move>[0]) => !readOnly && ws.move(l), [ws, readOnly]);
  const close = () => setDialog(null);
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
      Object.values(model.objects).find((o) => o.kind === 'schema' && o.name === 'public') ??
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
    if (ws.act('createTable', { id, schema: schema.id, name: `table_${n}` })) {
      ws.act('addColumn', {
        table: id,
        column: { id: newId(), name: 'id', type: 'bigint', notNull: true, identity: { always: false } },
      });
      setSelected(id);
    }
  };

  const env = envs.data?.[0];
  const latest = versions.data?.[0];
  const showInspector = pinned || selected !== null;

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
            {!readOnly && (
              <>
                <div className="flex gap-1.5">
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
                </div>
                <span className="h-5 w-px bg-border" aria-hidden="true" />
              </>
            )}
            <div className="flex gap-1.5">
              {!readOnly && (
                <button type="button" className="btn" onClick={() => setDialog('import')}>
                  <FileInput size={16} aria-hidden="true" />
                  <span className="max-[1080px]:hidden">{t('ws.import')}</span>
                </button>
              )}
              <Link to="/project/$owner/$project/environments" params={params} className="btn">
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
                <button type="button" className="btn" onClick={() => setDialog('publish')}>
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
                <div className="h-full">
                  <Canvas
                    model={model}
                    layout={layout}
                    selected={selected}
                    onSelect={setSelected}
                    onMove={onMove}
                    relayout={relayout}
                  />
                </div>
              ) : (
                <div className="h-full pt-12">
                  <SqlView text={ddl} label="DDL" />
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
            <Inspector selected={selected} ws={ws} model={model} readOnly={readOnly} onSelect={setSelected} />
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
        <span>{env ? t('ws.shadowOf', { env: env.name }) : t('ws.noEnv')}</span>
        <span className="flex-1" />
        {latest && <span className="font-mono">{latest.name}</span>}
        <span>PostgreSQL</span>
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
    </>
  );
};
