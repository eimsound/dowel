// 应用外壳（DESIGN.md：Layout）：48px 图标栏 + 随页面变化的侧面板 + 内容区。
// 侧面板的内容由页面通过 useShell().setSlot 提供（模型页是对象树，环境页是环境列表，组页是项目列表）；
// 页面没有提供内容时不显示面板。`[` 收起 / 展开，收起后顶栏出现展开按钮。
import type { GroupList, Me } from '@dowel/api';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  Bookmark,
  Database,
  FolderTree,
  Inbox,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  UserCog,
  Users,
  Workflow,
} from 'lucide-react';
import {
  createContext,
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { groupColor, groupInitial } from '../avatar.ts';
import { driftWarnings, useEnvs } from '../envs.ts';
import i18n, { setLang } from '../i18n.ts';
import { useInboxStream, useUnread } from '../requests.ts';
import { useSignOut } from '../session.ts';
import { getScheme, type Scheme, setScheme } from '../theme.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { Avatar, canHint, IconButton, Menu, type MenuItem } from './ui.tsx';

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
  /** 侧面板收起（宽屏）或抽屉未打开（窄屏） */
  closed: boolean;
  toggle: () => void;
  narrow: boolean;
  /** “打开侧面板”按钮：抽屉关闭后焦点回到它 */
  openButton: Ref<HTMLButtonElement>;
}

const ShellContext = createContext<ShellContextValue>({
  setSlot: () => {},
  hasSlot: false,
  closed: false,
  toggle: () => {},
  narrow: false,
  openButton: { current: null },
});

export const useShell = () => useContext(ShellContext);

/** 宽度 < 1024：侧面板变成抽屉（DESIGN.md：Responsive Behavior） */
const NARROW_QUERY = '(max-width: 1023px)';

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
  const { hasSlot, closed, toggle, narrow, openButton } = useShell();
  return (
    <header className="flex h-[var(--topbar-h)] shrink-0 items-center gap-2.5 border-b border-border bg-chrome px-3">
      {hasSlot && closed && (
        <IconButton
          ref={openButton}
          label={narrow ? t('nav.openDrawer') : t('nav.expandPanel')}
          onClick={toggle}
        >
          <PanelLeftOpen size={16} aria-hidden="true" />
        </IconButton>
      )}
      <nav aria-label={t('nav.breadcrumb')} className="flex min-w-0 items-center gap-1.5">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={`${c.label}-${c.to ?? 'current'}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && (
                <span aria-hidden="true" className="text-text-3">
                  /
                </span>
              )}
              {last || !c.to ? (
                <h1
                  className={`truncate text-[length:var(--fs-lg)] font-semibold ${c.mono ? 'font-mono' : ''}`}
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
        <div className="flex flex-1 items-center justify-center gap-3">{center}</div>
      ) : (
        <span className="flex-1" />
      )}
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
};

/** 侧面板：标签 + 收起按钮，内容是页面提供的 nav（对象树 / 环境列表 / 项目列表）。
 * 窄屏（< 1024）时同一个组件画成覆盖在内容上的抽屉。 */
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
      className={`flex w-[var(--sidebar-w)] shrink-0 flex-col border-r border-border bg-panel max-[1279px]:w-[200px] ${
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

/** 图标栏里的链接：悬停提示的文字与 aria-label 相同（DESIGN.md：悬停提示） */
const RailLink = ({
  to,
  params,
  label,
  tooltip,
  active,
  currentValue = 'page',
  temp = false,
  warn,
  badge,
  children,
}: {
  to: string;
  params?: Record<string, string>;
  label: string;
  /** 悬停提示（默认就是 label）；临时显示的组用它补一句“你不在这个组里” */
  tooltip?: string;
  active: boolean;
  /** 当前组不是“当前页”，用 aria-current="true"（TanStack Link 在 active 时会覆盖成 page） */
  currentValue?: 'page' | 'true';
  /** 不是我的组、因为正在看它才临时显示（虚线边框） */
  temp?: boolean;
  /**
   * 警告说明（例如环境有漂移）：图标右上角显示小圆点，说明文字用 aria-describedby 关联——
   * 不改链接的名字（名字仍然只是 label），读屏软件读完名字后再读说明。
   */
  warn?: string;
  /** 右上角的数字（收件箱未读数）；说明文字同样用 aria-describedby 关联 */
  badge?: { count: number; text: string };
  children: ReactNode;
}) => {
  const id = useId();
  const warnId = useId();
  const text = tooltip ?? label;
  return (
    <>
      <Link
        to={to}
        params={params}
        aria-label={label}
        aria-current={active ? currentValue : undefined}
        data-current={active ? '' : undefined}
        data-temp={temp ? '' : undefined}
        aria-describedby={warn || badge ? warnId : undefined}
        title={canHint ? undefined : text}
        {...(canHint ? { interestfor: id } : {})}
        className="rail-item"
      >
        {children}
        {warn && <span aria-hidden="true" className="rail-dot" />}
      </Link>
      {/* 未读数放在链接外面（叠在图标右上角）：链接的可访问名字只是 label，数字由 aria-describedby 的说明读出 */}
      {badge && badge.count > 0 && (
        <span aria-hidden="true" className="rail-badge" data-testid="inbox-unread">
          {badge.count > 99 ? '99+' : badge.count}
        </span>
      )}
      {(warn || badge) && (
        <span id={warnId} className="sr-only">
          {warn ?? badge?.text}
        </span>
      )}
      {canHint && (
        <div id={id} popover="hint" className="tooltip rail-tip">
          {text}
        </div>
      )}
    </>
  );
};

/** 收件箱入口：未读数实时更新（SSE，见 requests.ts 的 useInboxStream） */
const InboxLink = ({ active }: { active: boolean }) => {
  const { t } = useTranslation();
  useInboxStream();
  const unread = useUnread().data ?? 0;
  return (
    <RailLink
      to="/inbox"
      label={t('nav.inbox')}
      active={active}
      badge={{ count: unread, text: t('nav.inboxUnread', { count: unread }) }}
    >
      <Inbox size={16} aria-hidden="true" />
    </RailLink>
  );
};

/** 账户菜单：个人设置、管理后台、语言、配色、退出 */
const UserMenu = ({ me }: { me: Me }) => {
  const { t } = useTranslation();
  const nav = useNavigate();
  const signOut = useSignOut();
  const [scheme, setS] = useState(getScheme());
  const pick = (s: Scheme) => {
    setScheme(s);
    setS(s);
  };
  const items: MenuItem[] = [
    {
      label: t('nav.accountSettings'),
      icon: <UserCog size={16} aria-hidden="true" />,
      onSelect: () => void nav({ to: '/account' }),
    },
    ...(me.role === 'admin'
      ? [
          {
            label: t('nav.admin'),
            icon: <Settings size={16} aria-hidden="true" />,
            onSelect: () => void nav({ to: '/admin' }),
          },
        ]
      : []),
    ...(['zh', 'en'] as const).map((lng, i) => ({
      label: lng === 'zh' ? '中文' : 'English',
      checked: i18n.language === lng,
      separatorBefore: i === 0,
      onSelect: () => setLang(lng),
    })),
    ...(['auto', 'light', 'dark'] as const).map((s, i) => ({
      label: t(`settings.scheme.${s}`),
      checked: scheme === s,
      separatorBefore: i === 0,
      onSelect: () => pick(s),
    })),
    {
      label: t('auth.logout'),
      icon: <LogOut size={16} aria-hidden="true" />,
      danger: true,
      separatorBefore: true,
      onSelect: () => void signOut(),
    },
  ];
  return (
    <Menu
      label={t('nav.account')}
      heading={`${me.name} · ${me.username}`}
      trigger={<Avatar name={me.name} color="var(--me)" />}
      triggerClassName="rail-item"
      items={items}
    />
  );
};

const PROJECT_NAV: { key: ShellPage; label: string; icon: typeof Workflow }[] = [
  { key: 'overview', label: 'nav.overview', icon: LayoutDashboard },
  { key: 'model', label: 'nav.model', icon: Workflow },
  { key: 'versions', label: 'nav.versions', icon: Bookmark },
  { key: 'environments', label: 'nav.environments', icon: Database },
  { key: 'activity', label: 'nav.activity', icon: Activity },
  { key: 'members', label: 'nav.members', icon: Users },
  { key: 'settings', label: 'nav.settings', icon: Settings },
];

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
  /** 当前组（组页或项目页）；我的项目页为空 */
  groupSlug?: string;
  project?: ShellProject;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  const nav = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const groups = useQuery({
    queryKey: ['groups'],
    queryFn: () => api<GroupList>('GET', '/api/groups'),
  });
  // 图标栏“环境”上的漂移警告：和环境页共用 ['envs', pid] 这份缓存（执行 / 检查漂移后会刷新）
  const envs = useEnvs(project?.pid);
  const envWarn = driftWarnings(envs.data).length > 0;
  const [slot, setSlot] = useState<Slot | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const narrow = useNarrow();
  const [drawer, setDrawer] = useState(false);
  const openButton = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  // 宽屏收起；窄屏（< 1024）改成抽屉，默认不打开
  const closed = narrow ? !drawer : collapsed;
  const toggle = () => (narrow ? setDrawer((v) => !v) : setCollapsed((v) => !v));
  const closeDrawer = () => setDrawer(false);
  const page = pageFromPath(path, project);

  // 变宽屏时丢掉抽屉状态，避免从窄拖宽后遗留一个“已打开”的抽屉
  useEffect(() => {
    if (!narrow) setDrawer(false);
  }, [narrow]);

  // 抽屉打开：焦点移进去（第一个可聚焦元素）；Esc 关闭。
  // 关闭后把焦点还给“打开侧面板”：那个按钮在抽屉打开时不渲染，所以只能在关闭后的 effect 里聚焦。
  const hadDrawer = useRef(false);
  useEffect(() => {
    if (narrow && hadDrawer.current && !drawer) openButton.current?.focus();
    hadDrawer.current = drawer;
  }, [narrow, drawer]);

  useEffect(() => {
    if (!narrow || !drawer) return;
    const el = drawerRef.current?.querySelector<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    el?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrow, drawer]);

  // `[` 收起 / 展开侧面板（窄屏是打开 / 关闭抽屉）；输入框里按 `[` 不触发（是在输入文字）
  useEffect(() => {
    if (!slot) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"], dialog, [popover]')) return;
      e.preventDefault();
      if (narrow) setDrawer((v) => !v);
      else setCollapsed((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slot, narrow]);

  // `G` 加字母跳到项目页面：只在项目内、不在输入框里、不跟修饰键组合时生效。
  // armed / timer 放在 ref 里：effect 只在 project（已用 useMemo 稳定）或导航函数变化时重建。
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

  const base = project ? `/project/${project.owner}/${project.slug}` : null;
  const projectParams = project ? { owner: project.owner, project: project.slug } : undefined;
  /**
   * 图标栏只列“我是成员的组”。正在看的组如果不是我的组（组本身对所有人可见），
   * 就临时追加在分隔线下面，用虚线边框标明它不是我的组。
   */
  const myGroups = (groups.data?.groups ?? []).filter((g) => g.role !== null);
  const viewingGroup = groupSlug ? (groups.data?.groups ?? []).find((g) => g.slug === groupSlug) : undefined;
  const tempGroup = viewingGroup && viewingGroup.role === null ? viewingGroup : undefined;
  // 命令面板的“页面”分组：数组要稳定，否则面板里的 useMemo 每次渲染都重算
  const palettePages = useMemo(() => PROJECT_NAV.map((n) => ({ key: n.key, label: t(n.label) })), [t]);

  return (
    <ShellContext.Provider value={{ setSlot, hasSlot: !!slot, closed, toggle, narrow, openButton }}>
      <div className="flex h-dvh overflow-hidden bg-[var(--bg)]">
        <nav aria-label={t('nav.rail')} className="rail">
          <div className="rail-orgs">
            <Link
              to="/"
              aria-label={t('nav.myProjects')}
              aria-current={path === '/' ? 'page' : undefined}
              title={canHint ? undefined : t('nav.myProjects')}
              className="rail-item rail-org"
            >
              <Logo />
            </Link>
            {myGroups.map((g) => (
              <RailLink
                key={g.id}
                to="/group/$slug"
                params={{ slug: g.slug }}
                label={g.name}
                active={groupSlug === g.slug}
                currentValue="true"
              >
                <span
                  className="rail-org-av"
                  aria-hidden="true"
                  style={
                    groupSlug === g.slug
                      ? undefined
                      : { background: groupColor(g.slug), color: 'var(--text)' }
                  }
                >
                  {groupInitial(g.name)}
                </span>
              </RailLink>
            ))}
            {tempGroup && (
              <>
                <hr className="rail-sep" />
                <RailLink
                  to="/group/$slug"
                  params={{ slug: tempGroup.slug }}
                  label={tempGroup.name}
                  tooltip={`${tempGroup.name} · ${t('nav.tempGroup')}`}
                  active={groupSlug === tempGroup.slug}
                  currentValue="true"
                  temp
                >
                  <span
                    className="rail-org-av"
                    aria-hidden="true"
                    style={
                      groupSlug === tempGroup.slug
                        ? undefined
                        : { background: groupColor(tempGroup.slug), color: 'var(--text)' }
                    }
                  >
                    {groupInitial(tempGroup.name)}
                  </span>
                </RailLink>
              </>
            )}
          </div>
          {(groupSlug || project) && (
            <>
              <hr />
              {groupSlug && (
                <RailLink
                  to="/group/$slug"
                  params={{ slug: groupSlug }}
                  label={t('nav.groupHome')}
                  active={false}
                >
                  <FolderTree size={16} aria-hidden="true" />
                </RailLink>
              )}
              {base && (
                <div className="rail-pages">
                  {PROJECT_NAV.map((n) => {
                    const Icon = n.icon;
                    return (
                      <RailLink
                        key={n.key}
                        to={n.key === 'overview' ? base : `${base}/${n.key}`}
                        params={projectParams}
                        label={t(n.label)}
                        active={page === n.key}
                        warn={n.key === 'environments' && envWarn ? t('nav.driftWarn') : undefined}
                      >
                        <Icon size={16} aria-hidden="true" />
                      </RailLink>
                    );
                  })}
                </div>
              )}
            </>
          )}
          <span className="flex-1" />
          <InboxLink active={path === '/inbox'} />
          <UserMenu me={me} />
        </nav>
        {slot &&
          (narrow
            ? drawer && (
                <>
                  {/* 遮罩：点一下关闭；键盘用 Esc 和抽屉里的关闭按钮（遮罩本身不可聚焦） */}
                  <div className="drawer-backdrop" aria-hidden="true" onClick={closeDrawer} />
                  <SidePanel ref={drawerRef} drawer label={slot.label} toggle={closeDrawer}>
                    {slot.node}
                  </SidePanel>
                </>
              )
            : !collapsed && (
                <SidePanel label={slot.label} toggle={toggle}>
                  {slot.node}
                </SidePanel>
              ))}
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
      <CommandPalette me={me} project={project} pages={palettePages} />
    </ShellContext.Provider>
  );
};

/** 页面把侧面板内容交给外壳；离开页面时清空 */
export const useShellPanel = (label: string, node: ReactNode, deps: unknown[]) => {
  const { setSlot } = useShell();
  // biome-ignore lint/correctness/useExhaustiveDependencies: 调用方通过 deps 明确列出内容依赖
  useLayoutEffect(() => {
    setSlot({ label, node });
    return () => setSlot(null);
  }, [setSlot, label, ...deps]);
};
