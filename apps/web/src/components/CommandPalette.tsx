// ⌘K / Ctrl+K 命令面板（S6）：搜索组、可见项目、当前项目的页面、当前模型里的表，以及常用动作。
// 无障碍按 WAI-ARIA 的 combobox + listbox 模式实现：焦点始终在输入框上，用 aria-activedescendant 指向当前项；
// 外层是原生 <dialog>（showModal 负责焦点限制在面板内、Esc 关闭、关闭后焦点回到触发位置）。
import type { GroupList, Me, ProjectListItem } from '@dowel/api';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Bookmark,
  Database,
  FolderKanban,
  LayoutDashboard,
  Moon,
  Palette,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Table2,
  Users,
  Workflow,
} from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import { selectTable, useCurrentTables } from '../current-tables.ts';
import { nextScheme, setScheme, useScheme } from '../theme.ts';
import type { ShellPage, ShellProject } from './Shell.tsx';

interface Item {
  key: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

interface Group {
  key: string;
  label: string;
  items: Item[];
}

export interface PalettePage {
  key: ShellPage;
  label: string;
}

const PAGE_ICON: Record<ShellPage, ReactNode> = {
  overview: <LayoutDashboard size={16} aria-hidden="true" />,
  model: <Workflow size={16} aria-hidden="true" />,
  versions: <Bookmark size={16} aria-hidden="true" />,
  environments: <Database size={16} aria-hidden="true" />,
  activity: <Palette size={16} aria-hidden="true" />,
  members: <Users size={16} aria-hidden="true" />,
  settings: <Settings size={16} aria-hidden="true" />,
};

export const CommandPalette = ({
  me,
  project,
  pages,
  openRef,
}: {
  me: Me;
  project?: ShellProject;
  pages: PalettePage[];
  openRef?: RefObject<(() => void) | null>;
}) => {
  const { t } = useTranslation();
  const nav = useNavigate();
  const listId = useId();
  const dlg = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // 表清单是可订阅的：在模型页新建 / 删除表时面板里的列表跟着变
  const tables = useCurrentTables(project?.pid);
  const scheme = useScheme();
  const next = nextScheme(scheme);

  const groups = useQuery({
    queryKey: ['groups'],
    queryFn: () => api<GroupList>('GET', '/api/groups'),
    enabled: open,
  });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<ProjectListItem[]>('GET', '/api/projects'),
    enabled: open,
  });

  const close = () => setOpen(false);
  // 打开时记住焦点所在元素，关闭后还回去（对话框被移出 DOM 时浏览器会把焦点丢给 body）
  const restoreFocus = useRef<HTMLElement | null>(null);
  const show = useCallback(() => {
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setActive(0);
    setOpen(true);
  }, []);

  useLayoutEffect(() => {
    if (!openRef) return;
    openRef.current = show;
    return () => {
      openRef.current = null;
    };
  }, [openRef, show]);

  // ⌘K / Ctrl+K 打开（再按一次关闭）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (open) close();
        else show();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 打开：挂载对话框（只在打开时渲染），showModal 负责焦点限制在面板内
  useLayoutEffect(() => {
    const d = dlg.current;
    if (!open || !d || d.open) return;
    d.showModal();
    input.current?.focus();
  }, [open]);

  // 关闭：把焦点还给打开前的元素
  useEffect(() => {
    if (open) return;
    const el = restoreFocus.current;
    if (!el) return;
    restoreFocus.current = null;
    el.focus?.();
  }, [open]);

  const groupsAndProjects = useMemo(() => {
    // 关闭时不建列表：打开时按当前的组 / 项目 / 表重新算一遍（关着的时候数据可能已经变了）
    if (!open) return [];
    const out: Group[] = [];
    const params = project ? { owner: project.owner, project: project.slug } : null;

    const actions: Item[] = [
      {
        key: 'action:new-project',
        label: t('cmdk.newProject'),
        icon: <Plus size={16} aria-hidden="true" />,
        // 新建项目走四步向导（P3）；在组页里进来时预选这个组
        run: () =>
          void nav({
            to: '/new',
            search: project ? { group: project.owner } : {},
          }),
      },
      {
        key: 'action:new-group',
        label: t('cmdk.newGroup'),
        icon: <Plus size={16} aria-hidden="true" />,
        run: () => void nav({ to: '/', search: { new: 'group' } }),
      },
      {
        key: 'action:scheme',
        label: t('cmdk.switchScheme', { scheme: t(`acc.schemeOption.${next}`) }),
        icon: next === 'dark' ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />,
        run: () => setScheme(next),
      },
      {
        key: 'action:account',
        label: t('cmdk.account'),
        icon: <Settings size={16} aria-hidden="true" />,
        run: () => void nav({ to: '/account' }),
      },
      ...(me.role === 'admin'
        ? [
            {
              key: 'action:admin',
              label: t('cmdk.admin'),
              icon: <ShieldCheck size={16} aria-hidden="true" />,
              run: () => void nav({ to: '/admin' }),
            },
          ]
        : []),
    ];
    out.push({ key: 'actions', label: t('cmdk.actions'), items: actions });

    out.push({
      key: 'projects',
      label: t('cmdk.projects'),
      items: (projects.data ?? []).map((p) => ({
        key: `project:${p.id}`,
        label: p.name,
        hint: `${p.group.slug}/${p.slug}`,
        icon: <FolderKanban size={16} aria-hidden="true" />,
        run: () =>
          void nav({
            to: '/project/$owner/$project',
            params: { owner: p.group.slug, project: p.slug },
          }),
      })),
    });

    out.push({
      key: 'groups',
      label: t('cmdk.groups'),
      items: (groups.data?.groups ?? []).map((g) => ({
        key: `group:${g.id}`,
        label: g.name,
        hint: g.slug,
        icon: <Users size={16} aria-hidden="true" />,
        run: () => void nav({ to: '/group/$slug', params: { slug: g.slug } }),
      })),
    });

    if (project && params) {
      out.push({
        key: 'pages',
        label: t('cmdk.pages'),
        items: pages.map((p) => ({
          key: `page:${p.key}`,
          label: p.label,
          icon: PAGE_ICON[p.key],
          run: () =>
            void nav({
              to: `/project/${params.owner}/${params.project}${p.key === 'overview' ? '' : `/${p.key}`}`,
            }),
        })),
      });
      out.push({
        key: 'tables',
        label: t('cmdk.tables'),
        items: tables.map((tb) => ({
          key: `table:${tb.id}`,
          label: tb.name,
          hint: tb.schema,
          icon: <Table2 size={16} aria-hidden="true" />,
          run: () => selectTable(tb.id),
        })),
      });
    }
    return out.filter((g) => g.items.length > 0);
  }, [me.role, nav, open, pages, project, projects.data, groups.data, t, tables, next]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      groupsAndProjects
        .map((g) => ({
          ...g,
          items: q
            ? g.items.filter(
                (it) => it.label.toLowerCase().includes(q) || (it.hint ?? '').toLowerCase().includes(q),
              )
            : g.items,
        }))
        .filter((g) => g.items.length > 0),
    [groupsAndProjects, q],
  );
  const flat = filtered.flatMap((g) => g.items);
  const index = Math.min(active, Math.max(0, flat.length - 1));

  const run = (item: Item) => {
    close();
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 输入法组字中按回车是确认候选词，不能当成“执行当前项”（Safari / 部分安卓浏览器只给 keyCode 229）
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (!flat.length) return;
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? flat.length - 1
            : (index + (e.key === 'ArrowUp' ? -1 : 1) + flat.length) % flat.length;
      setActive(next);
      document.getElementById(optionId(listId, next))?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = flat[index];
      if (item) run(item);
    }
  };

  // 只在打开时渲染：关闭的对话框里不该有 listbox / 输入框。
  // 关闭也不调 d.close()（它的 close 事件是异步的，会和“马上再按一次 ⌘K”抢状态），直接卸载即可。
  if (!open) return null;
  return (
    <dialog
      ref={dlg}
      aria-label={t('cmdk.label')}
      onCancel={(e) => {
        // Esc：由状态驱动关闭，而不是让浏览器自己关（那样还会再派发 close 事件）
        e.preventDefault();
        close();
      }}
      className="cmdk-dialog m-auto w-[min(600px,94vw)] rounded-lg border border-border bg-panel p-0 text-text shadow-[var(--shadow-lg)]"
    >
      <div className="cmdk-search-row flex items-center gap-2 border-b border-border px-3">
        <Search size={16} aria-hidden="true" className="text-text-3" />
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={flat[index] ? optionId(listId, index) : undefined}
          aria-label={t('cmdk.label')}
          placeholder={t('cmdk.placeholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
          className="cmdk-search h-11 flex-1 border-0 bg-transparent text-text placeholder:text-text-3"
        />
        <kbd className="rounded-xs border border-border px-1 text-[length:var(--fs-xs)] text-text-3">Esc</kbd>
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={t('cmdk.label')}
        className="max-h-[min(420px,60vh)] overflow-auto p-1"
      >
        {filtered.map((g) => (
          <div key={g.key} role="group" aria-label={g.label} className="p-0">
            <div className="section-title px-2 pt-2 pb-1" aria-hidden="true">
              {g.label}
            </div>
            {g.items.map((it) => {
              const i = flat.indexOf(it);
              return (
                <button
                  key={it.key}
                  id={optionId(listId, i)}
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  tabIndex={-1}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(it)}
                  className="cmdk-item"
                >
                  <span className="text-text-3">{it.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-left">{it.label}</span>
                  {it.hint && (
                    <span className="truncate font-mono text-[length:var(--fs-xs)] text-text-3">
                      {it.hint}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
        {flat.length === 0 && <p className="px-3 py-6 text-center text-sm text-text-3">{t('cmdk.empty')}</p>}
      </div>
      <p className="border-t border-border px-3 py-2 text-[length:var(--fs-xs)] text-text-3">
        {t('cmdk.hint')}
      </p>
    </dialog>
  );
};

const optionId = (listId: string, i: number) => `${listId}-opt-${i}`;
