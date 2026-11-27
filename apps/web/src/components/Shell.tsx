// 应用外壳（DESIGN.md：Layout）：GitLab Super Sidebar 风格的单层上下文侧边栏 + 按需出现的页面工具面板（模型页对象树）+ 内容区。
// 全局导航侧边栏支持 Ctrl+\ 收起 / 展开并持久化到 localStorage；模型页通过 useShellPanel 提供对象树，`[` 收起 / 展开。
import type { Me } from '@dowel/api';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { ListTree, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { recordRecentProject } from '../recent-projects.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { PROJECT_NAV, SuperSidebar } from './SuperSidebar.tsx';
import { IconButton } from './ui.tsx';

export const Logo = () => (
  <span aria-hidden="true" className="relative inline-block size-[22px] shrink-0 rounded-[6px] bg-primary">
    <span className="absolute inset-x-[9px] inset-y-[6px] rounded-[2px] bg-chrome" />
  </span>
);

export interface ShellProject {
  /** 组的 slug，也就是 URL 里的 owner */
  owner: string;
  slug: string;
  name: string;
  /** 组显示名：供全局导航上级组链接显示 */
  groupName?: string;
  /** 项目 ID：命令面板要用它判断“当前模型里的表”属于这个项目 */
  pid?: string;
}

export type ShellPage =
  | 'overview'
  | 'model'
  | 'versions'
  | 'environments'
  | 'activity'
  | 'members'
  | 'settings';

interface Slot {
  label: string;
  node: ReactNode;
}

interface ShellContextValue {
  setSlot: (slot: Slot | null) => void;
  hasSlot: boolean;
  /** 侧面板（对象树）收起（宽屏）或抽屉未打开（窄屏） */
  closed: boolean;
  toggle: () => void;
  narrow: boolean;
  /** “打开侧面板”按钮：抽屉关闭后焦点回到它 */
  openButton: Ref<HTMLButtonElement>;
  /** 全局导航侧边栏收起（宽屏）或抽屉未打开（窄屏） */
  sidebarClosed: boolean;
  toggleSidebar: () => void;
  sidebarOpenButton: Ref<HTMLButtonElement>;
}

const ShellContext = createContext<ShellContextValue>({
  setSlot: () => {},
  hasSlot: false,
  closed: false,
  toggle: () => {},
  narrow: false,
  openButton: { current: null },
  sidebarClosed: false,
  toggleSidebar: () => {},
  sidebarOpenButton: { current: null },
});

export const useShell = () => useContext(ShellContext);

/** 宽度 < 1024：侧边栏与侧面板都变成抽屉（DESIGN.md：Responsive Behavior） */
const NARROW_QUERY = '(max-width: 1023px)';
const SIDEBAR_KEY = 'dowel.sidebar';

const readSidebarCollapsed = (): boolean => {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
  } catch {
    return false;
  }
};

export const useNarrow = () => {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
};

/** 顶栏面包屑：组 / 项目 / 页面；最后一段是当前页（h1，不是链接） */
export const PageHeader = ({
  crumbs,
  center,
  actions,
}: {
  crumbs: { label: string; to?: string; params?: Record<string, string>; mono?: boolean }[];
  center?: ReactNode;
  actions?: ReactNode;
}) => {
  const { t } = useTranslation();
  const { hasSlot, closed, toggle, narrow, openButton, sidebarClosed, toggleSidebar, sidebarOpenButton } =
    useShell();
  const hideParents = center ? '@max-[920px]:hidden' : '@max-[640px]:hidden';
  return (
    <header className="@container flex h-[var(--topbar-h)] shrink-0 items-center gap-2.5 border-b border-border bg-chrome px-3 @max-[640px]:gap-1.5 @max-[640px]:px-2">
      {sidebarClosed && (
        <IconButton
          ref={sidebarOpenButton}
          label={narrow ? t('nav.openSidebar') : t('nav.expandSidebar')}
          aria-expanded={!sidebarClosed}
          onClick={toggleSidebar}
        >
          {narrow ? (
            <MenuIcon size={16} aria-hidden="true" />
          ) : (
            <PanelLeftOpen size={16} aria-hidden="true" />
          )}
        </IconButton>
      )}
      {hasSlot && closed && (
        <IconButton
          ref={openButton}
          label={narrow ? t('nav.openDrawer') : t('nav.expandPanel')}
          aria-expanded={!closed}
          onClick={toggle}
        >
          {sidebarClosed && !narrow ? (
            <ListTree size={16} aria-hidden="true" />
          ) : (
            <PanelLeftOpen size={16} aria-hidden="true" />
          )}
        </IconButton>
      )}
      <nav aria-label={t('nav.breadcrumb')} className="flex min-w-0 items-center gap-1.5">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span
              key={`${c.label}-${c.to ?? 'current'}`}
              className={`flex min-w-0 items-center gap-1.5 ${!last ? hideParents : 'shrink-0'}`}
            >
              {i > 0 && (
                <span aria-hidden="true" className={`text-text-3 ${last ? hideParents : ''}`}>
                  /
                </span>
              )}
              {last || !c.to ? (
                <h1
                  className={`max-w-[16rem] truncate text-[length:var(--fs-lg)] font-semibold ${c.mono ? 'font-mono' : ''}`}
                  aria-current={last ? 'page' : undefined}
                >
                  {c.label}
                </h1>
              ) : (
                <Link
                  to={c.to}
                  params={c.params}
                  className="truncate font-medium text-text-2 no-underline hover:text-text"
                >
                  {c.label}
                </Link>
              )}
            </span>
          );
        })}
      </nav>
      {center ? (
        <div className="flex flex-1 items-center justify-center gap-3 @max-[920px]:gap-2 @max-[640px]:gap-1.5">
          {center}
        </div>
      ) : (
        <span className="flex-1" />
      )}
      {actions && <div className="flex shrink-0 items-center gap-1.5 @max-[640px]:gap-1">{actions}</div>}
    </header>
  );
};

/** 页面工作区侧面板（模型页对象树）：标题 + 收起按钮。
 * 窄屏（< 1024）时画成覆盖在内容上的抽屉。 */
const SidePanel = ({
  label,
  toggle,
  drawer,
  ref,
  children,
}: {
  label: string;
  toggle: () => void;
  drawer?: boolean;
  ref?: Ref<HTMLElement>;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  return (
    <aside
      ref={ref}
      aria-label={label}
      role={drawer ? 'dialog' : undefined}
      aria-modal={drawer ? true : undefined}
      className={`flex w-[var(--sidebar-w)] shrink-0 flex-col border-r border-border bg-panel ${
        drawer ? 'narrow-drawer' : ''
      }`}
    >
      <div className="flex h-[var(--topbar-h)] shrink-0 items-center gap-2 border-b border-border pr-2 pl-3.5">
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--fs-lg)] font-semibold">{label}</h2>
        <IconButton label={drawer ? t('nav.closeDrawer') : t('nav.collapsePanel')} onClick={toggle}>
          <PanelLeftClose size={16} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </aside>
  );
};

/** `G` 加字母跳到项目页面（DESIGN.md：快捷键） */
const GO_KEYS: Record<string, ShellPage> = {
  o: 'overview',
  m: 'model',
  v: 'versions',
  e: 'environments',
  a: 'activity',
  p: 'members',
  s: 'settings',
};

/** 当前页：从路径的最后一段判断（/project/o/p、/project/o/p/model…） */
export const pageFromPath = (path: string, project?: ShellProject): ShellPage | null => {
  if (!project) return null;
  const base = `/project/${project.owner}/${project.slug}`;
  if (path === base || path === `${base}/`) return 'overview';
  const rest = path.slice(base.length + 1).split('/')[0];
  // 执行申请的详情页属于环境
  if (rest === 'requests') return 'environments';
  return PROJECT_NAV.some((n) => n.key === rest) ? (rest as ShellPage) : null;
};

export const AppShell = ({
  me,
  groupSlug,
  project,
  children,
}: {
  me: Me;
  /** 当前组（组页、项目页或新建项目向导预选组）；我的项目页为空 */
  groupSlug?: string;
  project?: ShellProject;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  const nav = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const narrow = useNarrow();

  // 全局导航侧边栏状态（宽屏可持久化收起，窄屏为抽屉）
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [sidebarDrawer, setSidebarDrawer] = useState(false);
  const sidebarOpenButton = useRef<HTMLButtonElement>(null);
  const navDrawerRef = useRef<HTMLElement>(null);
  const navCloseButton = useRef<HTMLButtonElement>(null);
  const restoreNavFocus = useRef(false);

  // 页面工作区侧面板状态（仅模型页对象树使用）
  const [slot, setSlot] = useState<Slot | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const openButton = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const restoreObjFocus = useRef(false);

  const openPaletteRef = useRef<(() => void) | null>(null);

  const sidebarClosed = narrow ? !sidebarDrawer : sidebarCollapsed;
  const closed = narrow ? !drawer : collapsed;
  const page = pageFromPath(path, project);

  // 变宽屏时丢掉窄屏抽屉状态，避免从窄拖宽后遗留“已打开”的抽屉
  const [prevNarrow, setPrevNarrow] = useState(narrow);
  if (narrow !== prevNarrow) {
    setPrevNarrow(narrow);
    if (!narrow) {
      setDrawer(false);
      setSidebarDrawer(false);
    }
  }

  // 路由变化时自动关闭窄屏抽屉，不强行抢回触发按钮焦点
  const [prevPath, setPrevPath] = useState(path);
  if (path !== prevPath) {
    setPrevPath(path);
    if (sidebarDrawer) setSidebarDrawer(false);
    if (drawer) setDrawer(false);
  }

  const closeNavDrawer = (restore = true) => {
    restoreNavFocus.current = restore;
    setSidebarDrawer(false);
  };
  const closeObjDrawer = (restore = true) => {
    restoreObjFocus.current = restore;
    setDrawer(false);
  };

  const toggleSidebar = () => {
    if (narrow) {
      if (sidebarDrawer) closeNavDrawer(true);
      else {
        restoreObjFocus.current = false;
        setDrawer(false);
        setSidebarDrawer(true);
      }
      return;
    }
    setSidebarCollapsed((v) => {
      const next = !v;
      try {
        if (next) localStorage.setItem(SIDEBAR_KEY, 'collapsed');
        else localStorage.removeItem(SIDEBAR_KEY);
      } catch {
        // 忽略存储受限
      }
      return next;
    });
  };

  const toggle = () => {
    if (narrow) {
      if (drawer) closeObjDrawer(true);
      else {
        restoreNavFocus.current = false;
        setSidebarDrawer(false);
        setDrawer(true);
      }
      return;
    }
    setCollapsed((v) => !v);
  };

  // 记录最近访问项目，供上下文切换器使用
  useEffect(() => {
    if (!project) return;
    recordRecentProject({
      owner: project.owner,
      slug: project.slug,
      name: project.name,
      groupName: project.groupName ?? project.owner,
      pid: project.pid,
    });
  }, [project]);

  // 导航抽屉：打开时聚焦关闭按钮、Esc 关闭；手动/Esc/遮罩关闭后焦点归还打开按钮
  const hadNavDrawer = useRef(false);
  const prevNavPath = useRef(path);
  useEffect(() => {
    const pathChanged = prevNavPath.current !== path;
    prevNavPath.current = path;
    if (narrow && hadNavDrawer.current && !sidebarDrawer && !pathChanged && restoreNavFocus.current) {
      restoreNavFocus.current = false;
      sidebarOpenButton.current?.focus();
    }
    hadNavDrawer.current = sidebarDrawer;
  }, [narrow, sidebarDrawer, path]);

  useEffect(() => {
    if (!narrow || !sidebarDrawer) return;
    navCloseButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('dialog[open], [popover]:is(:popover-open, .\\:popover-open)')) return;
      e.preventDefault();
      restoreNavFocus.current = true;
      setSidebarDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrow, sidebarDrawer]);

  // 对象树抽屉：打开时焦点移进去，Esc / 遮罩 / 关闭按钮关闭后把焦点还给“打开侧面板”
  const hadDrawer = useRef(false);
  const prevObjPath = useRef(path);
  useEffect(() => {
    const pathChanged = prevObjPath.current !== path;
    prevObjPath.current = path;
    if (narrow && hadDrawer.current && !drawer && !pathChanged && restoreObjFocus.current) {
      restoreObjFocus.current = false;
      openButton.current?.focus();
    }
    hadDrawer.current = drawer;
  }, [narrow, drawer, path]);

  useEffect(() => {
    if (!narrow || !drawer) return;
    const el = drawerRef.current?.querySelector<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    el?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('dialog[open], [popover]:is(:popover-open, .\\:popover-open)')) return;
      e.preventDefault();
      restoreObjFocus.current = true;
      setDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrow, drawer]);

  const toggleSidebarRef = useRef(toggleSidebar);
  const toggleObjRef = useRef(toggle);
  useLayoutEffect(() => {
    toggleSidebarRef.current = toggleSidebar;
    toggleObjRef.current = toggle;
  });

  // `Ctrl+\` / `⌘\` 全局切换导航侧边栏；`[` 在有工作区对象面板时切换对象面板，否则切换导航侧边栏
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"], dialog, [popover]')) return;
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        !e.repeat &&
        (e.key === '\\' || e.code === 'Backslash')
      ) {
        e.preventDefault();
        toggleSidebarRef.current();
        return;
      }
      if (e.key === '[' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
        e.preventDefault();
        if (slot) toggleObjRef.current();
        else toggleSidebarRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slot]);

  // `G` 加字母跳到项目页面：只在项目内、不在输入框里、不跟修饰键组合时生效
  const gArmed = useRef(false);
  const gTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!project) return;
    const base = `/project/${project.owner}/${project.slug}`;
    const disarm = () => {
      gArmed.current = false;
      clearTimeout(gTimer.current);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"], dialog, [popover]')) return;
      const key = e.key.toLowerCase();
      if (!gArmed.current) {
        if (key !== 'g') return;
        gArmed.current = true;
        // 1.5 秒内没按第二个键就忘掉
        gTimer.current = setTimeout(disarm, 1500);
        return;
      }
      const target = GO_KEYS[key];
      disarm();
      if (!target) return;
      e.preventDefault();
      void nav({ to: target === 'overview' ? base : `${base}/${target}` });
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      disarm();
    };
  }, [project, nav]);

  // 命令面板的“页面”分组：数组要稳定，否则面板里的 useMemo 每次渲染都重算
  const palettePages = useMemo(() => PROJECT_NAV.map((n) => ({ key: n.key, label: t(n.label) })), [t]);
  const mainInert = narrow && (sidebarDrawer || drawer) ? true : undefined;

  return (
    <ShellContext.Provider
      value={{
        setSlot,
        hasSlot: !!slot,
        closed,
        toggle,
        narrow,
        openButton,
        sidebarClosed,
        toggleSidebar,
        sidebarOpenButton,
      }}
    >
      <div className="flex h-dvh overflow-hidden bg-[var(--bg)]">
        {narrow
          ? sidebarDrawer && (
              <>
                <div
                  className="drawer-backdrop is-nav"
                  aria-hidden="true"
                  onClick={() => closeNavDrawer(true)}
                />
                <SuperSidebar
                  me={me}
                  path={path}
                  groupSlug={groupSlug}
                  project={project}
                  page={page}
                  drawer
                  asideRef={navDrawerRef}
                  closeBtnRef={navCloseButton}
                  onClose={() => closeNavDrawer(true)}
                  onOpenPalette={() => openPaletteRef.current?.()}
                />
              </>
            )
          : !sidebarCollapsed && (
              <SuperSidebar
                me={me}
                path={path}
                groupSlug={groupSlug}
                project={project}
                page={page}
                onClose={toggleSidebar}
                onOpenPalette={() => openPaletteRef.current?.()}
              />
            )}
        {slot &&
          (narrow
            ? drawer && (
                <>
                  {/* 遮罩：点一下关闭；键盘用 Esc 和抽屉里的关闭按钮（遮罩本身不可聚焦） */}
                  <div className="drawer-backdrop" aria-hidden="true" onClick={() => closeObjDrawer(true)} />
                  <SidePanel ref={drawerRef} drawer label={slot.label} toggle={() => closeObjDrawer(true)}>
                    {slot.node}
                  </SidePanel>
                </>
              )
            : !collapsed && (
                <SidePanel label={slot.label} toggle={toggle}>
                  {slot.node}
                </SidePanel>
              ))}
        <div className="flex min-w-0 flex-1 flex-col" inert={mainInert}>
          {children}
        </div>
      </div>
      <CommandPalette me={me} project={project} pages={palettePages} openRef={openPaletteRef} />
    </ShellContext.Provider>
  );
};

/** 页面把工作区侧面板内容交给外壳；离开页面时清空 */
export const useShellPanel = (label: string, node: ReactNode, deps: unknown[]) => {
  const { setSlot } = useShell();
  useLayoutEffect(() => {
    setSlot({ label, node });
    return () => setSlot(null);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 调用方通过 deps 明确列出内容依赖
  }, [setSlot, label, ...deps]);
};
